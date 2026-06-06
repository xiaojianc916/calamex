//! 统一本地存储根目录解析与旧目录迁移。
//!
//! 历史上应用数据散落在多个互不相干的目录：
//! - `%APPDATA%\Calamex\ai-config.json`（AI 配置，最早期）
//! - `%APPDATA%\com.xiaojianc.Calamex\.notion-ide-ai\edits`（AI 编辑历史）
//! - `%APPDATA%\com.xiaojianc.Calamex\session.json`（会话快照）
//! - `%LOCALAPPDATA%\com.xiaojianc.Calamex\agent-sidecar`（本地 AI 服务运行时）
//! - 上一版又把它们分到 `%APPDATA%\.calamex` 与 `%LOCALAPPDATA%\.calamex` 两处。
//!
//! 现统一归到用户主目录下的单一品牌根 `~/.calamex`（Windows 即
//! `%USERPROFILE%\.calamex`，例如 `C:\Users\陈小建\.calamex`），按功能分子目录：
//! - `config/`：AI 配置（`ai.json`）与会话快照（`session.json`）
//! - `ai-edits/`：AI 编辑历史
//! - `ai-service/`：本地 AI 服务运行时（令牌 / 日志 / Node 编译缓存）
//!
//! 主目录路径不写死、跨平台动态解析，且始终可写，便于集中备份与排查。
//! 该模块是所有磁盘路径的唯一事实来源，避免各模块各自拼路径导致漂移。

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

/// 统一存储根目录名（位于用户主目录下）。
pub const APP_STORAGE_DIR_NAME: &str = ".calamex";

/// 解析当前用户主目录。
///
/// 解析顺序（不写死任何用户名 / 盘符，跨平台）：
/// 1. `USERPROFILE`（Windows 首选，例如 `C:\Users\陈小建`）
/// 2. `HOMEDRIVE` + `HOMEPATH`（Windows 回退，拼成完整主目录）
/// 3. `HOME`（类 Unix / 兜底）
///
/// 全部缺失时返回 `None`。
pub fn home_dir() -> Option<PathBuf> {
    resolve_home_from(|key| std::env::var_os(key))
}

/// 纯函数版便于单测：通过注入的取值闭包解析主目录，规则同 [`home_dir`]。
fn resolve_home_from<F>(get_env: F) -> Option<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    fn non_empty(value: OsString) -> Option<OsString> {
        if value.is_empty() { None } else { Some(value) }
    }

    if let Some(user_profile) = get_env("USERPROFILE").and_then(non_empty) {
        return Some(PathBuf::from(user_profile));
    }

    if let (Some(drive), Some(path)) = (
        get_env("HOMEDRIVE").and_then(non_empty),
        get_env("HOMEPATH").and_then(non_empty),
    ) {
        // 用字符串拼接而非 PathBuf::join：HOMEPATH 形如 `\Users\陈小建`，
        // 直接 join 在某些平台会被当作绝对路径而丢弃盘符。
        let mut combined = drive.to_string_lossy().into_owned();
        combined.push_str(&path.to_string_lossy());
        return Some(PathBuf::from(combined));
    }

    get_env("HOME").and_then(non_empty).map(PathBuf::from)
}

/// 统一存储根：`<home>/.calamex`。主目录不可解析时返回 `None`。
pub fn storage_root() -> Option<PathBuf> {
    Some(home_dir()?.join(APP_STORAGE_DIR_NAME))
}

/// 配置 + 用户历史的根目录，统一到 `<home>/.calamex`。
///
/// 保留该函数名以兼容既有调用方（AI 配置 / 编辑历史 / 会话快照）。
pub fn roaming_root() -> Option<PathBuf> {
    storage_root()
}

/// 运行时 / 缓存 / 日志的根目录，统一到 `<home>/.calamex`。
///
/// 主目录不可解析时回退系统临时目录，保证始终有一个可写位置。
pub fn local_root() -> PathBuf {
    storage_root().unwrap_or_else(|| std::env::temp_dir().join(APP_STORAGE_DIR_NAME))
}

/// 首次启动时把旧的分散目录 / 文件迁移到统一的 `~/.calamex` 结构下。
///
/// 设计原则：
/// - **幂等**：目标已存在则跳过，绝不覆盖既有新数据；
/// - **尽力而为**：任一步失败只记录日志，绝不 panic、绝不阻断启动；
/// - **同卷优先 rename**，失败再退回递归复制（跨卷场景）。
pub fn migrate_legacy_storage() {
    let Some(root) = storage_root() else {
        return;
    };

    // --- 上一版“漫游/本地分区”方案：%APPDATA%\.calamex、%LOCALAPPDATA%\.calamex ---
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        let prev_roaming = appdata.join(APP_STORAGE_DIR_NAME);
        if prev_roaming != root {
            migrate_path(&prev_roaming.join("config"), &root.join("config"));
            migrate_path(&prev_roaming.join("ai-edits"), &root.join("ai-edits"));
        }
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let prev_service = local_app_data.join(APP_STORAGE_DIR_NAME).join("ai-service");
        let new_service = root.join("ai-service");
        if prev_service != new_service {
            migrate_path(&prev_service, &new_service);
        }
    }

    // --- 更早期的分散目录 / 文件 ---
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        // AI 配置：%APPDATA%\Calamex\ai-config.json -> config\ai.json
        migrate_path(
            &appdata.join("Calamex").join("ai-config.json"),
            &root.join("config").join("ai.json"),
        );

        // AI 编辑历史 / 会话快照位于 Tauri 标识目录 %APPDATA%\com.xiaojianc.Calamex 下。
        let identifier_dir = appdata.join("com.xiaojianc.Calamex");
        migrate_path(
            &identifier_dir.join(".notion-ide-ai").join("edits"),
            &root.join("ai-edits"),
        );
        migrate_path(
            &identifier_dir.join("session.json"),
            &root.join("config").join("session.json"),
        );
    }

    // 本地 AI 服务运行时：%LOCALAPPDATA%\com.xiaojianc.Calamex\agent-sidecar -> ai-service
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        let legacy_service = local_app_data
            .join("com.xiaojianc.Calamex")
            .join("agent-sidecar");
        let new_service = root.join("ai-service");
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
    use std::collections::HashMap;
    use std::ffi::OsString;

    fn lookup(
        map: &HashMap<&'static str, &'static str>,
    ) -> impl Fn(&str) -> Option<OsString> + '_ {
        move |key| map.get(key).map(|value| OsString::from(*value))
    }

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "calamex-storage-paths-{tag}-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn home_dir_prefers_userprofile() {
        let env = HashMap::from([
            ("USERPROFILE", "C:\\Users\\陈小建"),
            ("HOMEDRIVE", "C:"),
            ("HOMEPATH", "\\Users\\someone-else"),
            ("HOME", "/home/someone-else"),
        ]);
        assert_eq!(
            resolve_home_from(lookup(&env)),
            Some(PathBuf::from("C:\\Users\\陈小建"))
        );
    }

    #[test]
    fn home_dir_falls_back_to_homedrive_homepath() {
        let env = HashMap::from([
            ("HOMEDRIVE", "C:"),
            ("HOMEPATH", "\\Users\\陈小建"),
            ("HOME", "/home/someone-else"),
        ]);
        assert_eq!(
            resolve_home_from(lookup(&env)),
            Some(PathBuf::from("C:\\Users\\陈小建"))
        );
    }

    #[test]
    fn home_dir_falls_back_to_home_when_windows_vars_absent() {
        let env = HashMap::from([("HOME", "/home/陈小建")]);
        assert_eq!(
            resolve_home_from(lookup(&env)),
            Some(PathBuf::from("/home/陈小建"))
        );
    }

    #[test]
    fn home_dir_ignores_empty_values() {
        let env = HashMap::from([
            ("USERPROFILE", ""),
            ("HOMEDRIVE", ""),
            ("HOMEPATH", ""),
            ("HOME", "/home/陈小建"),
        ]);
        assert_eq!(
            resolve_home_from(lookup(&env)),
            Some(PathBuf::from("/home/陈小建"))
        );
    }

    #[test]
    fn home_dir_is_none_when_all_env_absent() {
        let env: HashMap<&'static str, &'static str> = HashMap::new();
        assert_eq!(resolve_home_from(lookup(&env)), None);
    }

    #[test]
    fn storage_root_lives_under_home_when_resolvable() {
        if let Some(home) = home_dir() {
            assert_eq!(storage_root(), Some(home.join(APP_STORAGE_DIR_NAME)));
            assert!(local_root().ends_with(APP_STORAGE_DIR_NAME));
        }
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
