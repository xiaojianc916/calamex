// 终端域：本地 PTY 运行/交互所需的协议类型。

use thiserror::Error;

// 取消脚本运行时的信号模式：graceful 走 Ctrl-C(SIGINT)，kill 直接终止子进程。
pub const SIGNAL_MODE_GRACEFUL: &str = "graceful";
pub const SIGNAL_MODE_KILL: &str = "kill";

#[derive(Debug, Error)]
pub enum LocalWslTerminalExecError {
    #[error("WSL Link terminal payload 无效：{0}")]
    Payload(String),
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalRunScriptRequest {
    pub run_id: String,
    pub working_directory: String,
    pub execution_path: String,
    pub script_content: Option<String>,
    pub cleanup_paths: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

impl LocalWslTerminalRunScriptRequest {
    pub fn validate(&self) -> Result<(), LocalWslTerminalExecError> {
        ensure_field_non_empty(&self.run_id, "run_id")?;
        ensure_field_non_empty(&self.working_directory, "working_directory")?;
        ensure_field_non_empty(&self.execution_path, "execution_path")?;
        validate_terminal_size(self.cols, self.rows)
    }
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalOpenInteractiveRequest {
    pub session_id: String,
    pub working_directory: String,
    pub cols: u16,
    pub rows: u16,
}

impl LocalWslTerminalOpenInteractiveRequest {
    pub fn validate(&self) -> Result<(), LocalWslTerminalExecError> {
        ensure_field_non_empty(&self.session_id, "session_id")?;
        ensure_field_non_empty(&self.working_directory, "working_directory")?;
        validate_terminal_size(self.cols, self.rows)
    }
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalRunStarted {
    pub run_id: String,
    pub pid: u32,
    pub started_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalRunChunk {
    pub run_id: String,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalRunCompleted {
    pub run_id: String,
    pub exit_code: Option<i32>,
    pub finished_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalRunError {
    pub run_id: String,
    pub message: String,
    pub exit_code: Option<i32>,
    pub finished_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveOpened {
    pub session_id: String,
    pub cwd: String,
    pub pid: u32,
    pub opened_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveData {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveClosed {
    pub session_id: String,
    pub exit_code: Option<i32>,
    pub finished_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveAck {
    pub session_id: Option<String>,
    pub action: String,
}

#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveError {
    pub session_id: Option<String>,
    pub message: String,
    pub exit_code: Option<i32>,
    pub finished_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub enum LocalWslTerminalServerPayload {
    RunStarted(LocalWslTerminalRunStarted),
    RunChunk(LocalWslTerminalRunChunk),
    RunCompleted(LocalWslTerminalRunCompleted),
    RunError(LocalWslTerminalRunError),
    InteractiveOpened(LocalWslTerminalInteractiveOpened),
    InteractiveData(LocalWslTerminalInteractiveData),
    InteractiveClosed(LocalWslTerminalInteractiveClosed),
    InteractiveAck(LocalWslTerminalInteractiveAck),
    InteractiveError(LocalWslTerminalInteractiveError),
}

fn ensure_field_non_empty(
    value: &str,
    field: &'static str,
) -> Result<(), LocalWslTerminalExecError> {
    if value.trim().is_empty() {
        return Err(LocalWslTerminalExecError::Payload(format!(
            "{field} 不能为空。"
        )));
    }
    Ok(())
}

fn validate_terminal_size(cols: u16, rows: u16) -> Result<(), LocalWslTerminalExecError> {
    if cols < 2 || rows < 1 {
        return Err(LocalWslTerminalExecError::Payload(
            "终端尺寸必须有效。".to_string(),
        ));
    }
    Ok(())
}

// PTY 字节流的增量 UTF-8 解码器统一由 terminal::utf8_decoder 提供。这里保留
// LocalWslUtf8ChunkDecoder 名称作为零成本别名，供本域 PTY 读线程复用，
// 避免在本模块内重复实现一份相同的解码逻辑（不造第二个轮子）。
pub use super::utf8_decoder::Utf8ChunkDecoder as LocalWslUtf8ChunkDecoder;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_script_request_validate_rejects_blank_and_bad_size() {
        let valid = LocalWslTerminalRunScriptRequest {
            run_id: "run-1".to_string(),
            working_directory: "/tmp".to_string(),
            execution_path: "/tmp/x.sh".to_string(),
            script_content: None,
            cleanup_paths: vec![],
            cols: 80,
            rows: 24,
        };
        assert!(valid.validate().is_ok());

        let blank = LocalWslTerminalRunScriptRequest {
            run_id: "  ".to_string(),
            ..valid.clone()
        };
        assert!(blank.validate().is_err());

        let bad_size = LocalWslTerminalRunScriptRequest {
            cols: 1,
            ..valid.clone()
        };
        assert!(bad_size.validate().is_err());
    }

    #[test]
    fn open_interactive_request_validate_checks_fields_and_size() {
        let valid = LocalWslTerminalOpenInteractiveRequest {
            session_id: "main".to_string(),
            working_directory: "~".to_string(),
            cols: 120,
            rows: 40,
        };
        assert!(valid.validate().is_ok());
        assert!(
            LocalWslTerminalOpenInteractiveRequest {
                session_id: "  ".to_string(),
                ..valid.clone()
            }
            .validate()
            .is_err()
        );
    }
}
