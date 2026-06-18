// 终端域：本地 PTY 运行/交互所需的协议类型。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LocalWslTerminalExecError {
    #[error("WSL Link terminal payload 无效：{0}")]
    Payload(String),
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

/// 交互 shell 经 OSC 133/633 上报的生命周期标记（Shell Integration）。由交互读线程从输出流中
/// 剥离后上抛，events 层据此合成运行的 RunStarted/RunCompleted，取代旧的抓取/合成提示符方案。
#[derive(Debug, Clone)]
pub struct LocalWslTerminalInteractiveMark {
    pub session_id: String,
    pub mark: super::shell_integration::ShellIntegrationMark,
}

#[derive(Debug, Clone)]
pub enum LocalWslTerminalServerPayload {
    InteractiveOpened(LocalWslTerminalInteractiveOpened),
    InteractiveData(LocalWslTerminalInteractiveData),
    InteractiveClosed(LocalWslTerminalInteractiveClosed),
    InteractiveAck(LocalWslTerminalInteractiveAck),
    InteractiveError(LocalWslTerminalInteractiveError),
    InteractiveMark(LocalWslTerminalInteractiveMark),
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
