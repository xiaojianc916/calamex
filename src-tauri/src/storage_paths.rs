//! 统一本地存储根目录解析与旧目录迁移。
//!
//! 历史上应用数据散落在多个互不相干的目录：
//! - `%APPDATA%\Calamex\ai-config.json`（AI 配置）
//! - `%APPDATA%\com.xiaojianc.Calamex\.notion-ide-ai\edits`（AI 编辑历史）
//! - `%APPDATA%\com.xiaojianc.Calamex\session.json`（会话快照）
//! - `%LOCALAPPDATA%\com.xiaojianc.Calamex\agent-sidecar`（本地 AI 服务运行时）
//!
//! 现统一归到单一品牌根 `.calamex` 下，按“漫游 / 本地”语义分区：
//! - 漫游区（配置 + 用户历史）：`%APPDATA%\.calamex`
//! - 本地区（运行时 / 缓存 / 日志）：`%LOCALAPPDATA%\.calamex`
//!
//! 该模块是所有磁盘路径的唯一事实来源，避免各模块各自拼路径导致漂移。

use std::fs;
use std::path::{Path, PathBuf};

/// 统一存储根目录名（漫游区与本地区同名，靠所在基目录区分）。
pub const APP_STORAGE_DIR_NAME: &str = ".calamex";

/// 漫游数据根：`%APPDATA%\.calamex`。
///
/// 缺少 `APPDATA` 时回退 `$HOME`（非 Windows / 异常环境），二者皆无则返回 `None`。
pub fn roaming_root() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))?;
    Some(base.join(APP_STORAGE_DIR_NAME))
}

/// 本地数据根：`%LOCALAPPDATA%\.calamex`。
///
/// 缺少 `LOCALAPPDATA` 时回退系统临时目录，保证始终有一个可写位置。
pub fn local_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_STORAGE_DIR_NAME)
}

/// 首次启动时把旧的分散目录 / 文件迁移到统一的 `.calamex` 结构下。
///
/// 设计原则：
/// - **幂等**：目标已存在则跳过，绝不覆盖既有新数据；
/// - **尽力而为**：任一步失败只记录日志，绝不 panic、绝不阻断启动；
/// - **同卷优先 rename**，失败再退回递归复制（跨卷场景）。
pub fn migrate_legacy_storage() {
    if let (Some(roaming), Some(appdata)) = (
        roaming_root(),
        std::env::var_os("APPDATA").map(PathBuf::from),
    ) {
        // AI 配置：%APPDATA%\Calamex\ai-config.json -> .calamex\config\ai.json
        migrate_path(
            &appdata.join("Calamex").join("ai-config.json"),
            &roaming.join("config").join("ai.json"),
        );

        // AI 编辑历史 / 会话快照位于 Tauri 标识目录 %APPDATA%\com.xiaojianc.Calamex 下。
        let identifier_dir = appdata.join("com.xiaojianc.Calamex");
        migrate_path(
            &identifier_dir.join(".notion-ide-ai").join("edits"),
            &roaming.join("ai-edits"),
        );
        migrate_path(
            &identifier_dir.join("session.json"),
            &roaming.join("config").join("session.json"),
        );
    }

    // 本地 AI 服务运行时：%LOCALAPPDATA%\com.xiaojianc.Calamex\agent-sidecar -> .calamex\ai-service
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let legacy_service = local_app_data
            .join("com.xiaojianc.Calamex")
            .join("agent-sidecar");
        let new_service = local_root().join("ai-service");
        // 整目录迁移后，再把目录内的旧文件名规整为按功能命名。
        migrate_path(&legacy_service, &new_service);
        rename_within(&new_service, "agent-sidecar.token", "auth.token");
        rename_within(&new_service, "agent-sidecar.log", "service.log");
        rename_within(&new_service, "agent-sidecar.log.old", "service.log.old");
        rename_within(&new_service, ".node-compile-cache", "node-compile-cache");
    }
}

/// 把 `from` 迁移到 `to`：仅当 `from` 存在且 `to` 不存在时执行；先 rename，跨卷再复制后删。
fn migrate_path(from: &Path, to: &Path) {
    if !from.exists() || to.exists() {
        return;
    }
    if let Some(parent) = to.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            log_migration_warn("create-parent-failed", to, &error.to_string());
            return;
        }
    }
    if fs::rename(from, to).is_ok() {
        return;
    }
    // 跨卷或重命名失败：回退到递归复制 + 删除源。
    if let Err(error) = copy_recursively(from, to) {
        log_migration_warn("copy-failed", from, &error.to_string());
        return;
    }
    if let Err(error) = remove_path(from) {
        log_migration_warn("cleanup-failed", from, &error.to_string());
    }
}

/// 在同一父目录内把单个条目从旧名改为新名（用于规整 ai-service 内的文件名）。
fn rename_within(dir: &Path, old_name: &str, new_name: &str) {
    let from = dir.join(old_name);
    let to = dir.join(new_name);
    if !from.exists() || to.exists() {
        return;
    }
    if let Err(error) = fs::rename(&from, &to) {
        log_migration_warn("rename-failed", &from, &error.to_string());
    }
}

fn copy_recursively(from: &Path, to: &Path) -> std::io::Result<()> {
    if from.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursively(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to).map(|_| ())
    }
}

fn remove_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn log_migration_warn(event: &str, path: &Path, detail: &str) {
    eprintln!(
        "{}",
        serde_json::json!({
            "level": "warn",
            "scope": "storage-migration",
            "event": event,
            "path": path.display().to_string(),
            "detail": detail,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "calamex-storage-paths-{tag}-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn roots_use_unified_brand_dir() {
        assert!(local_root().ends_with(APP_STORAGE_DIR_NAME));
        if let Some(roaming) = roaming_root() {
            assert!(roaming.ends_with(APP_STORAGE_DIR_NAME));
        }
    }

    #[test]
    fn migrate_path_moves_file_and_is_idempotent() {
        let base = unique_temp_dir("migrate");
        let from = base.join("old").join("ai-config.json");
        let to = base.join(".calamex").join("config").join("ai.json");
        fs::create_dir_all(from.parent().unwrap()).unwrap();
        fs::write(&from, b"{}").unwrap();

        migrate_path(&from, &to);
        assert!(to.exists());
        assert!(!from.exists());

        // 再次迁移：目标已存在 -> 不应 panic、不覆盖既有数据。
        fs::write(&from, b"NEW").unwrap();
        migrate_path(&from, &to);
        assert_eq!(fs::read(&to).unwrap(), b"{}");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rename_within_normalizes_file_name() {
        let dir = unique_temp_dir("rename");
        fs::write(dir.join("agent-sidecar.token"), b"tok").unwrap();
        rename_within(&dir, "agent-sidecar.token", "auth.token");
        assert!(dir.join("auth.token").exists());
        assert!(!dir.join("agent-sidecar.token").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
