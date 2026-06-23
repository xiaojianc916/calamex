use super::{ExecutionEnvironment, ExecutionOption, ExecutorKind};
use std::{
    env,
    path::{Path, PathBuf},
};

#[tauri::command]
#[specta::specta]
pub async fn detect_execution_environment() -> Result<ExecutionEnvironment, String> {
    Ok(build_execution_environment(detect_wsl()))
}

pub(crate) fn line_count(content: &str) -> usize {
    if content.is_empty() {
        1
    } else {
        content.split('\n').count()
    }
}

/// 将 usize 计数安全转换为 u32（脚本行数 / 字符数等需填充 specta 协议的 u32 字段）。
///
/// 溢出时返回带标签的错误而非静默截断（`as u32` 会环绕），便于定位异常巨型输入；
/// `label` 用于在错误信息中标明被转换的计数含义（如「脚本行数」「脚本字符数」）。
pub(crate) fn count_to_u32(count: usize, label: &str) -> Result<u32, String> {
    u32::try_from(count).map_err(|_| format!("{label}超出 u32 上限（{count}）。"))
}

pub(crate) fn find_command_path(file_name: &str, extra_candidates: &[&str]) -> Option<PathBuf> {
    if let Some(path_var) = env::var_os("PATH") {
        for directory in env::split_paths(&path_var) {
            let candidate = directory.join(file_name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }

    if cfg!(windows)
        && let Some(local_app_data) = env::var_os("LOCALAPPDATA")
    {
        let winget_link = PathBuf::from(local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join(file_name);
        if is_executable_file(&winget_link) {
            return Some(winget_link);
        }
    }

    extra_candidates
        .iter()
        .map(PathBuf::from)
        .find(|candidate| is_executable_file(candidate))
}

/// 判断候选路径是否为「可执行的常规文件」。
///
/// 历史实现仅用 `Path::exists()`，会把同名目录、或不可执行的同名文件
/// 误判为命令，从而选出无法运行的「命令路径」。这里统一要求其为常规文件；
/// 在类 Unix 平台上再校验可执行位（user/group/other 任一 x 位），
/// Windows 上无 POSIX 执行位语义，以 is_file() 兜底。
fn is_executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 探测唯一执行环境 WSL2 的可执行文件路径。
///
/// WSL2 是本应用唯一的脚本执行环境。此前这里维护了「候选向量 + 30s 缓存 +
/// build/collect/probe 全套」脚手架，但实际只有一个硬编码候选、缓存的是一个
/// 恒定结果，且 probe 从不真正探活（仅判存在性，以避免 `wsl.exe --list` 在
/// 部分 Windows 环境下挂起阻塞启动）。按 YAGNI 收敛为一次直接的路径探测；
/// 真正的可用性由后续脚本执行链路兜底报错。
fn detect_wsl() -> Option<PathBuf> {
    find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"])
}

/// 由 WSL2 探测结果构建对前端暴露的执行环境视图。
///
/// 保持既有 IPC 契约（`ExecutionEnvironment` / `ExecutionOption`）不变：恒为
/// 单一 WSL2 选项，`available` / `has_any` 取决于是否找到 `wsl.exe`。
fn build_execution_environment(wsl_path: Option<PathBuf>) -> ExecutionEnvironment {
    let available = wsl_path.is_some();

    ExecutionEnvironment {
        recommended: ExecutorKind::Wsl,
        has_any: available,
        executors: vec![ExecutionOption {
            r#type: ExecutorKind::Wsl,
            label: "WSL2".to_string(),
            available,
            description: "唯一执行环境，所有脚本统一通过 WSL2 Linux 子系统运行。".to_string(),
            command_path: wsl_path.map(|value| value.to_string_lossy().to_string()),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_count_matches_editor_semantics() {
        // 空内容视为 1 行；与编辑器一致，行数 = 换行符数 + 1，
        // 末尾换行会额外形成一「行」（CodeMirror 同此语义）。
        assert_eq!(line_count(""), 1);
        assert_eq!(line_count("a"), 1);
        assert_eq!(line_count("a\nb"), 2);
        assert_eq!(line_count("a\nb\n"), 3);
        // CRLF 不会被重复计数。
        assert_eq!(line_count("a\r\nb"), 2);
    }

    #[test]
    fn count_to_u32_converts_and_reports_overflow() {
        // 正常范围内等值转换。
        assert_eq!(count_to_u32(0, "脚本行数"), Ok(0));
        assert_eq!(count_to_u32(42, "脚本行数"), Ok(42));
        assert_eq!(count_to_u32(u32::MAX as usize, "脚本字符数"), Ok(u32::MAX));
        // 超出 u32 上限时返回带标签的错误，而非静默环绕截断。
        // （usize 在 64 位平台上才能表达 > u32::MAX，故仅在此断言。）
        #[cfg(target_pointer_width = "64")]
        {
            let overflow = u32::MAX as usize + 1;
            let err = count_to_u32(overflow, "脚本行数").unwrap_err();
            assert!(err.contains("脚本行数"));
            assert!(err.contains("超出 u32 上限"));
        }
    }

    #[test]
    fn is_executable_file_rejects_missing_paths_and_directories() {
        assert!(!is_executable_file(Path::new(
            "/calamex/this-path/should-not-exist/xyz"
        )));
        // 目录不是可执行文件。
        assert!(!is_executable_file(&std::env::temp_dir()));
    }

    #[test]
    fn build_execution_environment_reports_available_when_wsl_present() {
        // 找到 wsl.exe：单一 WSL2 选项，available / has_any 为真，command_path 回填。
        let env = build_execution_environment(Some(PathBuf::from(
            "C:\\Windows\\System32\\wsl.exe",
        )));
        assert!(env.has_any);
        assert!(matches!(env.recommended, ExecutorKind::Wsl));
        assert_eq!(env.executors.len(), 1);
        let option = &env.executors[0];
        assert!(matches!(option.r#type, ExecutorKind::Wsl));
        assert!(option.available);
        assert_eq!(
            option.command_path.as_deref(),
            Some("C:\\Windows\\System32\\wsl.exe")
        );
    }

    #[test]
    fn build_execution_environment_reports_unavailable_when_wsl_missing() {
        // 未找到 wsl.exe：仍暴露单一 WSL2 选项，但 available / has_any 为假，无 command_path。
        let env = build_execution_environment(None);
        assert!(!env.has_any);
        assert_eq!(env.executors.len(), 1);
        let option = &env.executors[0];
        assert!(!option.available);
        assert!(option.command_path.is_none());
    }
}
