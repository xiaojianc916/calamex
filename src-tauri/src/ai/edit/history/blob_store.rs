//! AED 快照文件内容的唯一物理存储层：复用项目级 fjall Database 的一个独立
//! keyspace，而不是自建的裸 git 对象库。
//!
//! # 替代了什么
//! 旧实现（已删除）为快照 blob 内容单独维护一个裸 git 仓库
//! （`gix::init_bare` + `write_blob`/`find_blob`），只是为了借用 git 天生的
//! 「按内容哈希去重」「按哈希前缀分片存储」两个特性。但这个仓库自己承认
//! "本模块从不 git gc/repack"——也就是说每次写入都会在磁盘上留下一个永不
//! 收敛的 loose object 文件，这正是 git 官方文档警告的经典反模式，在
//! Windows/NTFS 上尤其代价高昂。与此同时，项目的其余全部 AED 元数据
//! （journal / pins / snapshot manifest）早已统一收敛到同一个 fjall
//! `Database` 句柄（见 `io::open_aed_database`），blob 内容却单独维护第二套
//! 存储系统，直接违背这个句柄的「唯一入口」设计初衷。
//!
//! 本模块改为把 blob 内容存进同一个 fjall `Database` 下新增的 `blobs`
//! keyspace，key 直接复用调用方已经算好的 BLAKE3 摘要（`patch::hash_text`
//! 采用的同一算法），不再需要 git 对象哈希（SHA-1）这第二套哈希体系，也不
//! 再需要任何裸仓库、任何手写的 loose object 路径拼接、任何 GC 缺失风险。
//!
//! # 有意的不兼容
//! 只认 `"blake3:<64 位十六进制摘要>"` 一种 blob key 格式。旧的
//! `"git:<oid>"` key 不再能被读取或删除——`read_blob`/`remove_blob` 对它们
//! 都是硬报错，本模块不做任何新旧兼容判断。真正过滤迁移前遗留 key 的唯一
//! 位置在上游 `snapshot::SnapshotManifest::has_live_blob`（基于本模块导出的
//! `is_valid_blob_key`）：只有全部文件都持有合法新格式 key 的快照，才会被
//! 认定为"内容仍然存活"。这是一次干净的存储底座替换：旧的临时（未 pin）
//! 快照全文会随之失效，等价于一次保留策略意义上的"提前过期"；快照清单
//! （manifest）本身不受影响，仍可正常列出。
//!
//! # 并发与原子性
//! 本模块不再自行加锁或自行 commit/persist：所有写入（`store_blob`）与删除
//! （`remove_blob`）都通过调用方传入的 `fjall::Batch` 入队，随调用方的批次
//! 一次性 `commit` + `persist`。这比旧实现（每个 blob 一次独立的 git 对象
//! 写入，加上一次独立的 manifest fjall 提交，一次快照 N+1 次落盘）更强：
//! 一次快照的全部 blob 内容与 manifest 更新现在共享同一次原子批量提交。

use crate::ai::edit::errors;
use fjall::{Batch, Database, Keyspace, KeyspaceCreateOptions};

const BLOBS_KEYSPACE: &str = "blobs";
const BLOB_KEY_PREFIX: &str = "blake3:";
const BLOB_HASH_HEX_LEN: usize = 64;

/// 打开（或按需创建）AED blob 内容 keyspace。与 snapshots keyspace 共享同一个
/// `Database` 句柄，因此不需要额外的锁或额外的库初始化路径。
pub fn open_blobs_keyspace(db: &Database) -> Result<Keyspace, String> {
    db.keyspace(BLOBS_KEYSPACE, KeyspaceCreateOptions::default)
        .map_err(|error| errors::snapshot_store_failed(format!("打开 blobs keyspace 失败：{error}")))
}

/// 把一份文件内容加入批次，返回 `"blake3:<hex>"` 形式的 blob key。
///
/// 相同内容始终产生同一个 key，天然去重——重复写入只是把同一个 key/value
/// 对再次放入批次，`commit` 时是幂等的覆盖写，不需要像旧实现那样调用一次
/// git 对象写入去触发它内部的去重逻辑，也不需要任何显式的“先查是否存在”。
pub fn store_blob(batch: &mut Batch, blobs: &Keyspace, content: &[u8]) -> String {
    let key = format!("{BLOB_KEY_PREFIX}{}", blake3::hash(content).to_hex());
    batch.insert(blobs, key.as_bytes().to_vec(), content.to_vec());
    key
}

/// 按 blob key 读取内容的原始字节。仅接受本模块写入的 `"blake3:<hex>"` key；
/// 格式不匹配（包括迁移前的 `"git:<oid>"` legacy key）时硬报错。
pub fn read_blob(blobs: &Keyspace, blob_key: &str) -> Result<Vec<u8>, String> {
    validate_blob_key(blob_key)?;
    blobs
        .get(blob_key)
        .map_err(|error| errors::snapshot_store_failed(format!("读取 blob 失败：{error}")))?
        .map(|value| value.to_vec())
        .ok_or_else(|| errors::snapshot_store_failed(format!("blob 内容不存在：{blob_key}")))
}

/// 把一次 blob 删除加入批次，返回被删除内容的字节数（用于配额统计）。
///
/// 只接受合法的 `"blake3:<hex>"` key。调用方（`snapshot::strip_manifest_blobs`）
/// 在调用本函数之前，已经通过 `is_valid_blob_key`/`has_live_blob` 把所有
/// 迁移前遗留的旧格式 key 过滤在外。
pub fn remove_blob(blobs: &Keyspace, batch: &mut Batch, blob_key: &str) -> Result<u64, String> {
    validate_blob_key(blob_key)?;
    let existing_len = blobs
        .get(blob_key)
        .map_err(|error| errors::snapshot_store_failed(format!("读取 blob 失败：{error}")))?
        .map(|value| value.len() as u64)
        .unwrap_or(0);
    batch.remove(blobs, blob_key.as_bytes().to_vec());
    Ok(existing_len)
}

/// 是否是本模块当前会写入 / 认可的 blob key 格式。上游（`snapshot.rs`）用它来
/// 判定一个快照清单里的引用是否仍然“存活”。
pub fn is_valid_blob_key(blob_key: &str) -> bool {
    validate_blob_key(blob_key).is_ok()
}

fn validate_blob_key(blob_key: &str) -> Result<(), String> {
    let hex = blob_key
        .strip_prefix(BLOB_KEY_PREFIX)
        .ok_or_else(|| errors::snapshot_store_failed("快照 blob key 格式无效或已是历史遗留格式。"))?;
    let is_valid_hex =
        hex.len() == BLOB_HASH_HEX_LEN && hex.bytes().all(|byte| byte.is_ascii_hexdigit());
    if is_valid_hex {
        Ok(())
    } else {
        Err(errors::snapshot_store_failed(
            "快照 blob key 格式无效或已是历史遗留格式。",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{is_valid_blob_key, open_blobs_keyspace, read_blob, remove_blob, store_blob};
    use fjall::Database;
    use std::path::PathBuf;

    fn open_db(temp_dir: &std::path::Path) -> Database {
        Database::builder(temp_dir.join("fjall"))
            .open()
            .expect("fjall database should open")
    }

    #[test]
    fn store_and_read_blob_roundtrips_and_dedupes_identical_content() {
        let temp_dir = temp_dir("aed-blob-store");
        std::fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let db = open_db(&temp_dir);
        let blobs = open_blobs_keyspace(&db).expect("blobs keyspace should open");

        let mut batch = db.batch();
        let key_a = store_blob(&mut batch, &blobs, b"echo shared");
        let key_b = store_blob(&mut batch, &blobs, b"echo shared");
        let key_c = store_blob(&mut batch, &blobs, b"echo different");
        batch.commit().expect("batch should commit");

        assert_eq!(key_a, key_b, "identical content must dedupe to the same blake3 key");
        assert_ne!(key_a, key_c);
        assert!(key_a.starts_with(super::BLOB_KEY_PREFIX));

        let restored = read_blob(&blobs, &key_a).expect("blob should read back");
        assert_eq!(restored, b"echo shared");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn remove_blob_deletes_entry_and_reports_freed_bytes() {
        let temp_dir = temp_dir("aed-blob-store-remove");
        std::fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let db = open_db(&temp_dir);
        let blobs = open_blobs_keyspace(&db).expect("blobs keyspace should open");

        let mut write_batch = db.batch();
        let key = store_blob(&mut write_batch, &blobs, b"to be removed");
        write_batch.commit().expect("batch should commit");

        let mut remove_batch = db.batch();
        let freed_bytes =
            remove_blob(&blobs, &mut remove_batch, &key).expect("blob should be removed");
        remove_batch.commit().expect("batch should commit");
        assert!(freed_bytes > 0);

        let read_result = read_blob(&blobs, &key);
        assert!(read_result.is_err(), "removed blob must no longer be readable");

        let mut noop_batch = db.batch();
        let freed_again = remove_blob(&blobs, &mut noop_batch, &key)
            .expect("removing an already-missing blob is a no-op");
        assert_eq!(freed_again, 0);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn read_and_remove_reject_malformed_or_legacy_keys() {
        let temp_dir = temp_dir("aed-blob-store-malformed");
        std::fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let db = open_db(&temp_dir);
        let blobs = open_blobs_keyspace(&db).expect("blobs keyspace should open");
        let mut batch = db.batch();

        // "git:<oid>" 是迁移前遗留的旧格式，"fjall:legacy-hash" 是更早一代的
        // 遗留格式，"blake3:not-hex-and-wrong-length" 是前缀正确但内容非法
        // 的新格式 key；三类都必须被拒绝。
        for bad_key in [
            "git:af09cf7c1b7e9a4a4e1f9e5f6a0d6a6a4e1f9e5f",
            "fjall:legacy-hash",
            "blake3:not-hex-and-wrong-length",
        ] {
            assert!(read_blob(&blobs, bad_key).is_err());
            assert!(remove_blob(&blobs, &mut batch, bad_key).is_err());
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn is_valid_blob_key_only_accepts_current_format() {
        let valid = format!("blake3:{}", blake3::hash(b"x").to_hex());
        assert!(is_valid_blob_key(&valid));
        assert!(!is_valid_blob_key("git:abcd"));
        assert!(!is_valid_blob_key("fjall:abcd"));
        assert!(!is_valid_blob_key("blake3:tooshort"));
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ))
    }
}
