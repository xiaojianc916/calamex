//! AED 快照文件内容的唯一物理存储层：一个内容寻址的裸 git 对象库。
//!
//! # 替代了什么
//! 旧实现（已删除）在 fjall keyspace（小文件，用内容哈希当 key 手写“去重”）与
//! 手搓的 CAS 目录树（大文件，`blobs/<2位前缀>/<剩余哈希>`，`atomic_write` 落盘）
//! 之间按 `SMALL_BLOB_MAX_BYTES` 硬编码阈值人工分流。这两件事——按内容哈希去重、
//! 按哈希前缀做目录分片以避免单目录海量小文件——正是 git 对象库天生就做的事情。
//! 本模块用一个裸 git 仓库整体替换掉这一整套手写逻辑：`write_blob` 内部即完成
//! 哈希计算、去重判断、分片落盘；不再需要任何大小阈值分支。
//!
//! # 有意的不兼容
//! 只认 `"git:<40 位十六进制 oid>"` 一种 blob key 格式。旧的 `"fjall:<hash>"` /
//! `"cas:<relative path>"` key 一律视为格式无效——本模块不做、也不打算做新旧双读
//! 兼容层。这是一次干净的存储底座替换：旧的临时（未 pin）快照全文会随之失效，
//! 等价于一次保留策略意义上的“提前过期”；快照清单（manifest）本身不受影响，
//! 仍可正常列出。
//!
//! # 并发
//! 本模块自身不加锁；调用方（`snapshot.rs`）必须已经持有
//! `io::storage_lock::with_storage_write_lock` / `with_storage_read_lock`，
//! 与 fjall `Database` 共享同一把 `journal.lock`，避免并发初始化/写入裸仓库。

use crate::ai::edit::errors;
use std::path::Path;

const BLOB_STORE_DIR: &str = "blobstore.git";
const BLOB_KEY_PREFIX: &str = "git:";

/// 打开（或按需初始化）AED blob 对象库。
///
/// 通过检测 `HEAD` 文件是否存在来判断“已初始化”，而不是尝试 `open` 后按错误
/// 类型回退——避免对 gix 内部错误枚举做脆弱的模式匹配。
pub fn open_blob_repo(storage_root: &Path) -> Result<gix::Repository, String> {
    let git_dir = storage_root.join(BLOB_STORE_DIR);

    if git_dir.join("HEAD").is_file() {
        return gix::open(git_dir.as_path()).map_err(|error| {
            errors::snapshot_store_failed(format!("打开 blob 对象库失败：{error}"))
        });
    }

    std::fs::create_dir_all(&git_dir).map_err(|error| {
        errors::snapshot_store_failed(format!("创建 blob 对象库目录失败：{error}"))
    })?;
    gix::init_bare(git_dir.as_path())
        .map_err(|error| errors::snapshot_store_failed(format!("初始化 blob 对象库失败：{error}")))
}

/// 写入一份文件内容，返回 `"git:<oid>"` 形式的 blob key。
///
/// 相同内容始终返回同一个 key（`write_blob` 按内容哈希去重的原生行为），无需
/// 再像旧实现那样用 `content_hash` 手动当 key 查重。
pub fn store_blob(repo: &gix::Repository, content: &[u8]) -> Result<String, String> {
    let id = repo
        .write_blob(content)
        .map_err(|error| errors::snapshot_store_failed(format!("写入 blob 对象失败：{error}")))?;
    Ok(format!("{BLOB_KEY_PREFIX}{id}"))
}

/// 按 blob key 读取内容的原始字节。仅接受本模块写入的 `"git:<oid>"` key。
pub fn read_blob(repo: &gix::Repository, blob_key: &str) -> Result<Vec<u8>, String> {
    let oid = parse_blob_key(blob_key)?;
    let blob = repo
        .find_blob(oid)
        .map_err(|error| errors::snapshot_store_failed(format!("读取 blob 对象失败：{error}")))?;
    Ok(blob.data.to_vec())
}

/// 删除一个 blob 对象的 loose object 文件，返回释放的磁盘字节数。
///
/// `write_blob` 只会产出 loose object（本模块从不 `git gc`/repack），因此可以
/// 按 git 标准 loose object 布局（`objects/<前2位>/<后38位>`）直接定位文件并
/// 删除，无需通过 gix 的高层 API 做对象级 GC。
pub fn remove_blob(storage_root: &Path, blob_key: &str) -> Result<u64, String> {
    let oid = parse_blob_key(blob_key)?;
    let hex = oid.to_string();
    let (prefix, suffix) = hex.split_at(2);
    let object_path = storage_root
        .join(BLOB_STORE_DIR)
        .join("objects")
        .join(prefix)
        .join(suffix);

    remove_file_reporting_size(&object_path)
}

fn parse_blob_key(blob_key: &str) -> Result<gix::ObjectId, String> {
    let hex = blob_key.strip_prefix(BLOB_KEY_PREFIX).ok_or_else(|| {
        errors::snapshot_store_failed("快照 blob key 格式无效（缺少 git: 前缀）。")
    })?;
    hex.parse::<gix::ObjectId>()
        .map_err(|error| errors::snapshot_store_failed(format!("解析 blob 对象 id 失败：{error}")))
}

fn remove_file_reporting_size(path: &Path) -> Result<u64, String> {
    let removed_bytes = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => {
            return Err(errors::snapshot_store_failed(format!(
                "删除 blob 对象失败（{}）：{error}",
                path.display()
            )));
        }
    };

    std::fs::remove_file(path).map_err(|error| {
        errors::snapshot_store_failed(format!("删除 blob 对象失败（{}）：{error}", path.display()))
    })?;

    Ok(removed_bytes)
}

#[cfg(test)]
mod tests {
    use super::{open_blob_repo, read_blob, remove_blob, store_blob};
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn store_and_read_blob_roundtrips_and_dedupes_identical_content() {
        let temp_dir = temp_dir("aed-blob-store");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let repo = open_blob_repo(&temp_dir).expect("blob repo should open");
        let key_a = store_blob(&repo, b"echo shared").expect("blob should be written");
        let key_b = store_blob(&repo, b"echo shared").expect("duplicate blob should be written");
        let key_c =
            store_blob(&repo, b"echo different").expect("distinct blob should be written");

        assert_eq!(
            key_a, key_b,
            "identical content must dedupe to the same git object id"
        );
        assert_ne!(key_a, key_c);
        assert!(key_a.starts_with(super::BLOB_KEY_PREFIX));

        let restored = read_blob(&repo, &key_a).expect("blob should read back");
        assert_eq!(restored, b"echo shared");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn reopening_existing_blob_repo_reuses_previously_written_objects() {
        let temp_dir = temp_dir("aed-blob-store-reopen");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let key = {
            let repo = open_blob_repo(&temp_dir).expect("blob repo should open");
            store_blob(&repo, b"persisted content").expect("blob should be written")
        };

        let reopened = open_blob_repo(&temp_dir).expect("blob repo should reopen");
        let restored = read_blob(&reopened, &key).expect("blob should read back after reopen");
        assert_eq!(restored, b"persisted content");

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn remove_blob_deletes_loose_object_and_reports_freed_bytes() {
        let temp_dir = temp_dir("aed-blob-store-remove");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");

        let key = {
            let repo = open_blob_repo(&temp_dir).expect("blob repo should open");
            store_blob(&repo, b"to be removed").expect("blob should be written")
        };

        let freed_bytes = remove_blob(&temp_dir, &key).expect("blob should be removed");
        assert!(freed_bytes > 0);

        let repo = open_blob_repo(&temp_dir).expect("blob repo should reopen");
        let read_result = read_blob(&repo, &key);
        assert!(
            read_result.is_err(),
            "removed blob must no longer be readable"
        );

        let freed_again =
            remove_blob(&temp_dir, &key).expect("removing an already-missing blob is a no-op");
        assert_eq!(freed_again, 0);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn read_blob_rejects_malformed_keys() {
        let temp_dir = temp_dir("aed-blob-store-malformed");
        fs::create_dir_all(&temp_dir).expect("temp directory should be created");
        let repo = open_blob_repo(&temp_dir).expect("blob repo should open");

        assert!(read_blob(&repo, "fjall:legacy-hash").is_err());
        assert!(read_blob(&repo, "cas:blobs/ab/cdef").is_err());
        assert!(read_blob(&repo, "git:not-a-valid-oid").is_err());

        let _ = fs::remove_dir_all(&temp_dir);
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
