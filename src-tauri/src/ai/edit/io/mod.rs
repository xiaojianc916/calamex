pub mod atomic_write;
pub mod file_transaction;
pub mod storage_lock;

use crate::ai::edit::errors;
use fjall::Database;
use std::path::Path;

const AED_DB_DIR: &str = "fjall";

/// 打开（或恢复）项目级 AED fjall 存储库的单一句柄。
///
/// 各历史子模块（operations / snapshots / pins / file_transactions）原本各自
/// `Database::builder(...).open()`，一次 retention 最多开 4 次库。这里提供统一入口，
/// 让调用方在单一写锁内只打开一次 `Database`、按需 `db.keyspace(...)` 复用同一句柄。
///
/// 不变量：调用方需自行持有 `journal.lock`（见 `storage_lock`）。
pub fn open_aed_database(storage_root: &Path) -> Result<Database, String> {
    Database::builder(storage_root.join(AED_DB_DIR))
        .open()
        .map_err(|error| errors::journal_failed(format!("打开 fjall AED 存储失败：{error}")))
}
