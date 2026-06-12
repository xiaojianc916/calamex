//! SSH connection pool – multiplexes SFTP / exec channels over long-lived connections.
//!
//! ## Architecture
//! * A single `Handle<SshClientHandler>` is cached per `(host, port, username, auth_tag)` key.
//! * Multiple concurrent operations share the same Handle, each opening its own SFTP channel.
//! * The pool is NOT a set of exclusive connections – it's a map of shared Handles.
//!
//! ## Lifecycle
//! * **Idle eviction**: handles unused for >10 min are closed by the background cleanup task.
//! * **Error eviction**: callers call `evict()` when a connection-level error is detected.
//! * **Capacity eviction**: `acquire`'s slow path bounds total entries via LRU once a new
//!   connection is established, so pathological churn can't grow the pool without limit.
//! * **Background cleanup**: a periodic sweep runs every 60 s.
//!
//! ## Concurrency model
//! Two-level locking avoids the "thundering herd" problem on a cold cache:
//! * **Outer lock** (`entries`): only held briefly to look up / insert a per-key slot.
//! * **Inner lock** (per-key `Mutex<Option<PoolEntry>>`): serialises concurrent connects
//!   to the *same* host while letting different hosts connect in parallel.
//!
//! When N tasks ask for the same uncached host simultaneously, only the first one
//! performs the actual SSH handshake; the rest wait on the per-key mutex and then
//! hit the cache.
//!
//! ## auth_tag
//! Derived via blake3 from the actual credential material (password bytes / identity path),
//! NOT from password length. This prevents accidental pool key collisions when:
//! * Password changes but length stays the same.
//! * Two different users happen to have same-length passwords on the same host.
//!
//! **Note**: This hash is *not* persisted and *not* used for any security decision –
//! it is purely an in-memory cache discriminator. The pool relies on the SSH layer
//! itself for authentication. A salt / KDF is therefore unnecessary.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use russh::client::Handle;
use tokio::sync::Mutex;

use super::ssh::{SshClientHandler, SshConnectionParams, connect_and_auth};

// ---- constants ----

const POOL_MAX_IDLE: Duration = Duration::from_secs(600); // 10 minutes
const POOL_CLEANUP_INTERVAL: Duration = Duration::from_secs(60);
/// 连接池缓存条目（按 host:port:user:auth 计）的总量上限。
/// 仅靠空闲清理无法覆盖“短时间大量不同连接”的极端场景,故在 `acquire` 慢路径
/// 新建连接后按 LRU 驱逐空闲连接,防止句柄无界累积耗尽 fd / 远端会话。
const POOL_MAX_ENTRIES: usize = 32;

// ---- shutdown signalling ----

/// 应用退出时置位:后台清理任务在下一次 `select!` 时感知并退出,避免空转。
static POOL_SHUTDOWN: AtomicBool = AtomicBool::new(false);
/// 用于在关停时立即唤醒正在等待 tick 的清理任务(否则最坏要等满一个清理周期)。
static POOL_SHUTDOWN_NOTIFY: LazyLock<tokio::sync::Notify> =
    LazyLock::new(tokio::sync::Notify::new);

// ---- connection key ----

/// Uniquely identifies a pooled connection.
///
/// `auth_tag` is a blake3 hash of (auth_mode, identity_path, password) –
/// it discriminates different credentials targeting the same host:port:username
/// without keeping the raw password in cache-key memory.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ConnKey {
    host: String,
    port: u16,
    username: String,
    /// First 8 bytes of blake3(auth_mode || identity_path || password).
    auth_tag: u64,
}

impl ConnKey {
    fn from_params(params: &SshConnectionParams) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(params.auth_mode.as_bytes());
        hasher.update(b"\x00"); // domain separator
        if let Some(ref p) = params.identity_path {
            // `OsStr::new` accepts &str, &String, &Path, &PathBuf, &OsStr, &OsString.
            // `as_encoded_bytes` is cross-platform (stable since Rust 1.74) –
            // unlike `OsStrExt::as_bytes`, which is Unix-only.
            hasher.update(OsStr::new(p).as_encoded_bytes());
        }
        hasher.update(b"\x00");
        if let Some(ref pw) = params.password {
            hasher.update(pw.as_bytes());
        }
        let hash = hasher.finalize();

        // Truncate to 8 bytes – sufficient as an in-memory cache discriminator
        // (collision probability is negligible at the scale of a single-user
        // desktop app's connection pool).
        let mut tag_bytes = [0u8; 8];
        tag_bytes.copy_from_slice(&hash.as_bytes()[..8]);
        let auth_tag = u64::from_ne_bytes(tag_bytes);

        Self {
            host: params.host.clone(),
            port: params.port,
            username: params.username.clone(),
            auth_tag,
        }
    }
}

// ---- pool entry ----

struct PoolEntry {
    handle: Arc<Handle<SshClientHandler>>,
    last_used: Instant,
}

impl PoolEntry {
    fn is_idle_expired(&self, now: Instant) -> bool {
        now.duration_since(self.last_used) > POOL_MAX_IDLE
    }
}

/// A per-key slot. Wrapping the entry in a `Mutex<Option<...>>` lets concurrent
/// acquires for the *same* key serialise on the inner mutex (preventing
/// duplicate handshakes), while acquires for *different* keys remain parallel.
type Slot = Arc<Mutex<Option<PoolEntry>>>;

// ---- pool ----

pub(crate) struct SshConnectionPool {
    entries: Mutex<HashMap<ConnKey, Slot>>,
}

impl SshConnectionPool {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire a shared handle for the given connection parameters.
    ///
    /// Returns an `Arc<Handle>`; the handle remains in the pool for reuse.
    /// Updates `last_used` on every hit so that idle eviction tracks real
    /// activity, not just creation time.
    ///
    /// If multiple tasks request the same uncached key concurrently, only the
    /// first one performs the SSH handshake; the rest wait and then hit the
    /// cache.
    pub(crate) async fn acquire(
        &self,
        params: &SshConnectionParams,
    ) -> Result<Arc<Handle<SshClientHandler>>, String> {
        // Lazy-start the background cleanup task on first use.
        // tokio::spawn works here because acquire() is always called from
        // an async Tauri command handler, i.e. inside the Tokio runtime.
        static CLEANUP_SPAWNED: AtomicBool = AtomicBool::new(false);
        if !CLEANUP_SPAWNED.swap(true, Ordering::Relaxed) {
            tokio::spawn(async {
                let mut interval = tokio::time::interval(POOL_CLEANUP_INTERVAL);
                interval.tick().await; // skip first immediate tick
                loop {
                    tokio::select! {
                        _ = interval.tick() => {
                            if POOL_SHUTDOWN.load(Ordering::Relaxed) {
                                break;
                            }
                            POOL.cleanup().await;
                        }
                        _ = POOL_SHUTDOWN_NOTIFY.notified() => break,
                    }
                }
            });
        }

        let key = ConnKey::from_params(params);

        // Step 1: get or create the per-key slot.
        // The outer lock is held only for this brief lookup.
        let slot: Slot = {
            let mut entries = self.entries.lock().await;
            entries
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };

        // Step 2: take the per-key lock. Different keys do this in parallel;
        // the same key serialises here.
        let mut guard = slot.lock().await;
        let now = Instant::now();

        // Fast path: live entry, not expired.
        if let Some(entry) = guard.as_mut() {
            if !entry.is_idle_expired(now) {
                entry.last_used = now;
                return Ok(Arc::clone(&entry.handle));
            }
            // Expired – drop the old entry, then fall through to reconnect.
            *guard = None;
        }

        // Slow path: establish a new SSH connection.
        // Note: if `evict()` removes this slot from the outer map while we're
        // here, our newly-built handle is still returned to *this* caller, but
        // it won't be visible to future acquires (they'll build their own).
        // That's the intended behaviour – evict means "this key's pooled state
        // is suspect, start fresh".
        let handle = Arc::new(connect_and_auth(params).await?);
        *guard = Some(PoolEntry {
            handle: Arc::clone(&handle),
            last_used: now,
        });
        // 先释放内层槽锁,再做总量收口:① 不在持锁状态下跨 await;② 让刚插入的最新
        // 连接处于“未占用”可见状态——它 last_used 最新,排在驱逐序列末尾,不会被误删。
        drop(guard);
        self.enforce_capacity().await;
        Ok(handle)
    }

    /// 给连接池总量加上限并按 LRU 驱逐空闲连接。
    ///
    /// 由 `acquire` 慢路径在新建连接后调用。条目数不超上限时直接返回;超限时用
    /// `try_lock` 探查可驱逐的空闲槽(`try_lock` 失败说明正被占用,跳过不动),
    /// 按“空槽(驱逐残留)优先,其次 last_used 从旧到新”排序后删除到上限以内。
    /// 与 `cleanup` 一致:始终先持外层 `entries` 锁,再对各槽 `try_lock`,不跨 await。
    async fn enforce_capacity(&self) {
        let mut entries = self.entries.lock().await;
        if entries.len() <= POOL_MAX_ENTRIES {
            return;
        }

        // 仅把当前未被占用的槽纳入可驱逐候选;正被持有的槽(try_lock 失败)说明
        // 正在使用,保留不动。
        let mut evictable: Vec<(ConnKey, Option<Instant>)> = entries
            .iter()
            .filter_map(|(conn_key, slot)| match slot.try_lock() {
                Ok(slot_guard) => Some((
                    conn_key.clone(),
                    slot_guard.as_ref().map(|entry| entry.last_used),
                )),
                Err(_) => None,
            })
            .collect();

        // 空槽(None)最先驱逐,其次按 last_used 从旧到新。
        evictable.sort_by(|left, right| match (left.1, right.1) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Less,
            (Some(_), None) => std::cmp::Ordering::Greater,
            (Some(left_used), Some(right_used)) => left_used.cmp(&right_used),
        });

        let mut overflow = entries.len() - POOL_MAX_ENTRIES;
        for (conn_key, _) in evictable {
            if overflow == 0 {
                break;
            }
            entries.remove(&conn_key);
            overflow -= 1;
        }
    }

    /// Remove a connection from the pool (e.g. after a connection-level I/O error).
    ///
    /// The underlying TCP / SSH connection is closed when the last `Arc<Handle>`
    /// reference is dropped, which may be after in-flight operations finish.
    pub(crate) async fn evict(&self, params: &SshConnectionParams) {
        let key = ConnKey::from_params(params);
        let mut entries = self.entries.lock().await;
        entries.remove(&key);
    }

    /// Sweep idle entries. Called periodically by the background cleanup task.
    ///
    /// Uses `try_lock` on each slot so that connections currently in use
    /// (i.e. someone else holds the slot's mutex) are skipped – they can't
    /// be idle by definition.
    pub(crate) async fn cleanup(&self) {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;
        let before = entries.len();

        entries.retain(|_key, slot| match slot.try_lock() {
            Ok(guard) => match guard.as_ref() {
                Some(entry) => !entry.is_idle_expired(now),
                None => false, // empty slot (post-eviction artefact) – drop
            },
            Err(_) => true, // in use right now, keep
        });

        let evicted = before - entries.len();
        if evicted > 0 {
            tracing::debug!(
                evicted,
                remaining = entries.len(),
                "ssh pool: cleaned idle connections"
            );
        }
    }

    /// 关闭连接池:清空所有缓存连接。底层 TCP/SSH 在最后一个 `Arc<Handle>`
    /// 引用被释放时关闭,因此正在进行的操作完成后连接会自然断开。
    pub(crate) async fn shutdown(&self) {
        let mut entries = self.entries.lock().await;
        entries.clear();
    }
}

// ---- global pool singleton ----

pub(crate) static POOL: LazyLock<SshConnectionPool> = LazyLock::new(SshConnectionPool::new);

/// 应用退出时调用:置位关停标志并唤醒后台清理任务退出,随后清空连接池。
///
/// 与进程直接退出相比,这里主动断开池内长连接,避免远端遗留半开会话。
pub(crate) async fn shutdown_ssh_pool() {
    POOL_SHUTDOWN.store(true, Ordering::Relaxed);
    POOL_SHUTDOWN_NOTIFY.notify_waiters();
    POOL.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn shutdown_clears_pool_entries() {
        let pool = SshConnectionPool::new();
        {
            let mut entries = pool.entries.lock().await;
            entries.insert(
                ConnKey {
                    host: "example.com".to_string(),
                    port: 22,
                    username: "user".to_string(),
                    auth_tag: 42,
                },
                Arc::new(Mutex::new(None)),
            );
        }
        assert_eq!(pool.entries.lock().await.len(), 1);
        pool.shutdown().await;
        assert!(pool.entries.lock().await.is_empty());
    }

    #[tokio::test]
    async fn enforce_capacity_bounds_total_entries() {
        let pool = SshConnectionPool::new();
        {
            let mut entries = pool.entries.lock().await;
            for index in 0..(POOL_MAX_ENTRIES + 8) {
                entries.insert(
                    ConnKey {
                        host: format!("host-{index}"),
                        port: 22,
                        username: "user".to_string(),
                        auth_tag: index as u64,
                    },
                    Arc::new(Mutex::new(None)),
                );
            }
        }
        assert_eq!(pool.entries.lock().await.len(), POOL_MAX_ENTRIES + 8);

        pool.enforce_capacity().await;
        assert_eq!(pool.entries.lock().await.len(), POOL_MAX_ENTRIES);
    }

    #[tokio::test]
    async fn enforce_capacity_keeps_in_use_entries() {
        let pool = SshConnectionPool::new();
        let in_use_key = ConnKey {
            host: "in-use".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_tag: 99,
        };
        let in_use_slot: Slot = Arc::new(Mutex::new(None));
        {
            let mut entries = pool.entries.lock().await;
            entries.insert(in_use_key.clone(), Arc::clone(&in_use_slot));
            for index in 0..POOL_MAX_ENTRIES {
                entries.insert(
                    ConnKey {
                        host: format!("host-{index}"),
                        port: 22,
                        username: "user".to_string(),
                        auth_tag: index as u64,
                    },
                    Arc::new(Mutex::new(None)),
                );
            }
        }
        assert_eq!(pool.entries.lock().await.len(), POOL_MAX_ENTRIES + 1);

        // 持有该槽的内层锁,模拟“正在使用”:enforce_capacity 的 try_lock 会失败并跳过它,
        // 因此它必定被保留,被驱逐的只能是其它空闲槽。
        let slot_guard = in_use_slot.lock().await;
        pool.enforce_capacity().await;
        drop(slot_guard);

        let entries = pool.entries.lock().await;
        assert_eq!(entries.len(), POOL_MAX_ENTRIES);
        assert!(entries.contains_key(&in_use_key));
    }
}
