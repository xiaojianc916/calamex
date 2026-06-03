use super::{ExecutionEnvironment, ExecutionOption, ExecutorKind};
use std::{
    env,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const EXECUTOR_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone)]
struct ExecutorCandidate {
    kind: ExecutorKind,
    label: &'static str,
    description: &'static str,
    path: Option<PathBuf>,
    available: bool,
}

#[derive(Clone)]
struct CachedExecutorCandidates {
    captured_at: Instant,
    executors: Vec<ExecutorCandidate>,
}

static EXECUTOR_CANDIDATES_CACHE: Mutex<Option<CachedExecutorCandidates>> = Mutex::new(None);

#[tauri::command]
#[specta::specta]
pub async fn detect_execution_environment() -> Result<ExecutionEnvironment, String> {
    let executors = collect_executor_candidates().await;
    Ok(build_execution_environment(&executors))
}

pub(crate) fn line_count(content: &str) -> usize {
    if content.is_empty() {
        1
    } else {
        content.split('\n').count()
    }
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

    if cfg!(windows) {
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
            let winget_link = PathBuf::from(local_app_data)
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join(file_name);
            if is_executable_file(&winget_link) {
                return Some(winget_link);
            }
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

async fn collect_executor_candidates() -> Vec<ExecutorCandidate> {
    if let Some(executors) = read_cached_executor_candidates() {
        return executors;
    }

    let mut executors = build_executor_candidates();

    for item in executors.iter_mut() {
        item.available = probe_executor(item).await;
    }

    cache_executor_candidates(&executors);
    executors
}

fn build_executor_candidates() -> Vec<ExecutorCandidate> {
    vec![ExecutorCandidate {
        kind: ExecutorKind::Wsl,
        label: "WSL2",
        description: "唯一执行环境，所有脚本统一通过 WSL2 Linux 子系统运行。",
        path: find_command_path("wsl.exe", &["C:\\Windows\\System32\\wsl.exe"]),
        available: false,
    }]
}

fn read_cached_executor_candidates() -> Option<Vec<ExecutorCandidate>> {
    let cache = EXECUTOR_CANDIDATES_CACHE.lock().ok()?;
    let entry = cache.as_ref()?;
    if entry.captured_at.elapsed() > EXECUTOR_CACHE_TTL {
        return None;
    }

    Some(entry.executors.clone())
}

fn cache_executor_candidates(executors: &[ExecutorCandidate]) {
    if let Ok(mut cache) = EXECUTOR_CANDIDATES_CACHE.lock() {
        *cache = Some(CachedExecutorCandidates {
            captured_at: Instant::now(),
            executors: executors.to_vec(),
        });
    }
}

fn build_execution_environment(executors: &[ExecutorCandidate]) -> ExecutionEnvironment {
    let has_any = executors.iter().any(|item| item.available);

    ExecutionEnvironment {
        recommended: ExecutorKind::Wsl,
        has_any,
        executors: executors
            .iter()
            .map(|item| ExecutionOption {
                r#type: item.kind.clone(),
                label: item.label.to_string(),
                available: item.available,
                description: item.description.to_string(),
                command_path: item
                    .path
                    .as_ref()
                    .map(|value| value.to_string_lossy().to_string()),
            })
            .collect(),
    }
}

async fn probe_executor(candidate: &ExecutorCandidate) -> bool {
    if !matches!(candidate.kind, ExecutorKind::Wsl) {
        return false;
    }

    // 避免在启动阶段执行 wsl.exe 健康探测。
    // 某些 Windows 环境下 `wsl.exe --list --quiet` 会长时间挂起，导致前端初始化无法继续。
    // 启动只做命令存在性判断，实际运行时再由脚本执行链路兜底错误。
    candidate.path.is_some()
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
    fn is_executable_file_rejects_missing_paths_and_directories() {
        assert!(!is_executable_file(Path::new(
            "/calamex/this-path/should-not-exist/xyz"
        )));
        // 目录不是可执行文件。
        assert!(!is_executable_file(&std::env::temp_dir()));
    }
}
