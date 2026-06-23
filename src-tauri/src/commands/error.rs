//! 跨命令统一的「错误码 + 人类可读消息」线缆 DTO（#2 后端错误码灰度）。
//!
//! tauri-specta（ErrorHandlingMode::Throw）会把命令的 Err 值序列化为 `{ code, message }`，
//! 前端 invoke 以该对象 reject；normalizeIpcError 兼容层据 `code` 归一为 AppError
//!（见 src/services/tauri.ipc-runtime.ts）。
//!
//! 各域定义自己的 typed error enum（如 format::FormatErrorKind），仅在 `#[tauri::command]`
//! 边界经 `From` 收敛到本 DTO，保证「域内强类型穷尽 + 线缆形态统一」。待所有命令完成迁移，
//! 前端即可删除 errorMap / resolveMappedError 这套基于子串匹配的旧兜底。

use serde::Serialize;
use specta::Type;
use thiserror::Error;

/// 序列化给前端的命令错误：稳定 `code` + 后端权威 `message`。
#[derive(Debug, Clone, Error, Serialize, Type)]
#[error("{message}")]
pub struct CommandError {
    /// 稳定错误码，带域命名空间（如 `"format.timeout"`），前端据此分支处理。
    pub code: String,
    /// 人类可读消息（后端权威文案）。
    pub message: String,
}

impl CommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
