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
        Ok(handle)
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
}
