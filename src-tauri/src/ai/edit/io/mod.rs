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

/// 在 journal.lock 写锁临界区内打开唯一 AED Database 句柄并执行写闭包。
///
/// 这是 AED 历史存储唯一的可变访问入口：先获取项目级写锁，再打开同一存储目录上
/// 唯一的 Database，最后把句柄借给闭包。edit_journal / pins / snapshot 的历史函数
/// 全部退化为「只接受 &Database 的 keyspace 级操作」，不再各自加锁 / 开库，从根上
/// 消除「locked 版 + _with_db 版」双轨。闭包内可顺序复用同一句柄完成多步读改写
/// （如 retention：list -> prune -> GC），全程零额外开库。
pub fn with_aed_database_write<T>(
    storage_root: &Path,
    action: &str,
    run: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    storage_lock::with_storage_write_lock(storage_root, action, || {
        let db = open_aed_database(storage_root)?;
        run(&db)
    })
}

/// 在 journal.lock 读锁临界区内打开唯一 AED Database 句柄并执行只读闭包。
///
/// 语义同 with_aed_database_write，但使用共享读锁，供 list_timeline 等只读路径在
/// 单锁单句柄内合并多次读取（如 pins + operations）。
pub fn with_aed_database_read<T>(
    storage_root: &Path,
    action: &str,
    run: impl FnOnce(&Database) -> Result<T, String>,
) -> Result<T, String> {
    storage_lock::with_storage_read_lock(storage_root, action, || {
        let db = open_aed_database(storage_root)?;
        run(&db)
    })
}
