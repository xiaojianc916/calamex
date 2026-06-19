use super::super::decode_script_bytes;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::UNIX_EPOCH,
};

/// 单个文件超过该大小时不写入内容缓存：仍会被解码返回，但不占用缓存预算，
/// 避免个别超大文件挤占大量内存。与 trigram 索引的单文件上限保持一致。
const MAX_CACHED_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 单个工作区内容缓存的总字节预算（已解码文本）。超出后按插入顺序淘汰最早的条目。
const MAX_CACHE_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// 文件内容指纹：长度 + 修改时间。任一变化即视为内容已变，触发重新读取。
/// 与符号缓存的 mtime/len 失效策略一致；此处不额外做内容哈希，避免为校验而重新读盘
/// （读盘正是缓存要省去的开销）。
#[derive(Clone, PartialEq, Eq)]
struct ContentFingerprint {
    len: u64,
    modified_nanos: Option<u128>,
}

#[derive(Clone)]
struct CachedContent {
    fingerprint: ContentFingerprint,
    text: Arc<str>,
}

/// 每工作区一个内容缓存：按 relative_path 存放已解码文本，并维护插入顺序与总字节数，
/// 以便在超出预算时做有界淘汰。
struct WorkspaceContentCache {
    entries: HashMap<String, CachedContent>,
    insertion_order: VecDeque<String>,
    total_bytes: usize,
}

impl WorkspaceContentCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
            total_bytes: 0,
        }
    }

    fn get(&self, relative_path: &str, fingerprint: &ContentFingerprint) -> Option<Arc<str>> {
        let cached = self.entries.get(relative_path)?;
        (cached.fingerprint == *fingerprint).then(|| Arc::clone(&cached.text))
    }

    fn store(&mut self, relative_path: String, content: CachedContent) {
        let added = content.text.len();
        match self.entries.insert(relative_path.clone(), content) {
            // 覆盖同一文件的旧条目：仅调整字节计数，键已在插入顺序队列中，无需重复入队。
            Some(previous) => {
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(previous.text.len())
                    .saturating_add(added);
            }
            None => {
                self.total_bytes = self.total_bytes.saturating_add(added);
                self.insertion_order.push_back(relative_path);
            }
        }
        self.evict_to_budget(MAX_CACHE_TOTAL_BYTES);
    }

    /// 按插入顺序淘汰最早的条目，直到总字节数不超过 budget。淘汰队列中可能存在已被移除的
    /// 残留键（覆盖写不重复入队，但删除走预算淘汰）；遇到 entries 中已不存在的键直接跳过。
    fn evict_to_budget(&mut self, budget: usize) {
        while self.total_bytes > budget {
            let Some(evict_key) = self.insertion_order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&evict_key) {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.text.len());
            }
        }
    }
}

static WORKSPACE_CONTENT_CACHES: OnceLock<Mutex<HashMap<String, WorkspaceContentCache>>> =
    OnceLock::new();

/// 返回文件已解码内容的共享句柄（`Arc<str>`），按 (len, mtime) 指纹缓存，供结构化 / 模糊
/// 搜索与 trigram 索引构建共用，避免同一文件在多次搜索（含防抖反复触发、索引重建）中被
/// 重复读盘 + 解码（编码探测 + 转码是其中较贵的一步）。
///
/// 失效完全由 per-file 指纹承担：内容变化（长度或 mtime 改变）会自动重新读取并刷新缓存，
/// 因此无需在文件监听里整表失效；已删除文件的残留条目永不被命中（仅对当前扫描集中的文件
/// 调用），并随预算淘汰回收。
///
/// 读盘 / 解码失败返回 None，调用方按「跳过该文件」处理，与原先的 fs::read 语义一致。
/// 锁只在 HashMap 查改的瞬间持有；读盘与解码均在锁外进行，避免阻塞其它并行文件。
pub(super) fn workspace_file_text(
    root: &Path,
    relative_path: &str,
    path: &Path,
) -> Option<Arc<str>> {
    let fingerprint = file_fingerprint(path)?;
    let cacheable = fingerprint.len <= MAX_CACHED_FILE_BYTES;
    let cache_key = root.to_string_lossy().to_string();
    let caches = WORKSPACE_CONTENT_CACHES.get_or_init(|| Mutex::new(HashMap::new()));

    if cacheable
        && let Ok(guard) = caches.lock()
        && let Some(cache) = guard.get(&cache_key)
        && let Some(text) = cache.get(relative_path, &fingerprint)
    {
        return Some(text);
    }

    // 锁外读盘 + 解码（昂贵部分不持锁）。
    let bytes = fs::read(path).ok()?;
    let (content, _encoding) = decode_script_bytes(&bytes).ok()?;
    let text: Arc<str> = Arc::from(content);

    if cacheable && let Ok(mut guard) = caches.lock() {
        let cache = guard
            .entry(cache_key)
            .or_insert_with(WorkspaceContentCache::new);
        cache.store(
            relative_path.to_string(),
            CachedContent {
                fingerprint,
                text: Arc::clone(&text),
            },
        );
    }

    Some(text)
}

fn file_fingerprint(path: &Path) -> Option<ContentFingerprint> {
    let metadata = fs::metadata(path).ok()?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    Some(ContentFingerprint {
        len: metadata.len(),
        modified_nanos,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root() -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应可用")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "calamex-search-content-cache-test-{}-{suffix}",
            std::process::id()
        ))
    }

    fn cached(text: &str) -> CachedContent {
        CachedContent {
            fingerprint: ContentFingerprint {
                len: text.len() as u64,
                modified_nanos: Some(0),
            },
            text: Arc::from(text),
        }
    }

    #[test]
    fn evicts_oldest_entries_when_over_budget() {
        let mut cache = WorkspaceContentCache::new();
        cache.store("a".to_string(), cached("aaaa"));
        cache.store("b".to_string(), cached("bbbb"));
        cache.store("c".to_string(), cached("cccc"));
        assert_eq!(cache.total_bytes, 12);

        // 预算 8：应按插入顺序淘汰最早的 "a"，保留较新的 "b"/"c"。
        cache.evict_to_budget(8);
        assert!(!cache.entries.contains_key("a"));
        assert!(cache.entries.contains_key("b"));
        assert!(cache.entries.contains_key("c"));
        assert_eq!(cache.total_bytes, 8);
    }

    #[test]
    fn reinserting_same_key_updates_bytes_without_duplicate_queue_entry() {
        let mut cache = WorkspaceContentCache::new();
        cache.store("a".to_string(), cached("aaaa"));
        cache.store("a".to_string(), cached("bb"));
        assert_eq!(cache.total_bytes, 2);
        assert_eq!(cache.insertion_order.len(), 1);
        assert_eq!(cache.entries.get("a").map(|entry| &*entry.text), Some("bb"));
    }

    #[test]
    fn get_misses_when_fingerprint_differs() {
        let mut cache = WorkspaceContentCache::new();
        cache.store("a".to_string(), cached("hello"));
        let same = ContentFingerprint {
            len: 5,
            modified_nanos: Some(0),
        };
        let changed = ContentFingerprint {
            len: 5,
            modified_nanos: Some(1),
        };
        assert!(cache.get("a", &same).is_some());
        assert!(cache.get("a", &changed).is_none());
    }

    #[test]
    fn caches_decoded_text_and_refreshes_after_change() {
        let root = temp_root();
        fs::create_dir_all(&root).expect("应创建临时目录");
        let path = root.join("a.sh");
        fs::write(&path, "alpha").expect("应写入测试文件");

        let first = workspace_file_text(&root, "a.sh", &path).expect("应读取内容");
        assert_eq!(&*first, "alpha");

        // 文件未变：再次取用应命中缓存并复用同一 Arc 分配。
        let second = workspace_file_text(&root, "a.sh", &path).expect("应命中缓存");
        assert!(Arc::ptr_eq(&first, &second), "缓存命中应复用同一 Arc 分配");

        // 内容变化（长度不同 -> 指纹变化）应重新读取并返回新内容。
        fs::write(&path, "beta-longer").expect("应覆盖测试文件");
        let third = workspace_file_text(&root, "a.sh", &path).expect("应读取新内容");
        assert_eq!(&*third, "beta-longer");
        assert!(!Arc::ptr_eq(&second, &third));

        fs::remove_dir_all(&root).expect("应清理临时目录");
    }
}
