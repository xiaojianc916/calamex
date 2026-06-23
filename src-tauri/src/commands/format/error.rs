//! `format_document` 域的 typed 错误（#2 后端错误码灰度首个落地域）。
//!
//! 域内以强类型穷尽各失败分支（thiserror 提供 Display 文案），仅在命令边界经
//! `From<FormatErrorKind> for CommandError` 收敛为统一线缆 DTO。新增域请照此范式：
//! 定义本域 `XxxErrorKind` + 实现到 `CommandError` 的 `From`，绝不在前端做子串匹配。

use thiserror::Error;

use crate::commands::CommandError;

#[derive(Debug, Error)]
pub(crate) enum FormatErrorKind {
    /// 启动 formatter 子进程失败。
    #[error("启动 {formatter} 失败：{message}")]
    SpawnFailed { formatter: String, message: String },

    /// 向 formatter 写入或关闭 stdin 失败。
    #[error("写入 {formatter} 输入失败：{message}")]
    StdinFailed { formatter: String, message: String },

    /// 等待 formatter 子进程结束时出错。
    #[error("运行 {formatter} 失败：{message}")]
    RunFailed { formatter: String, message: String },

    /// formatter 在超时时间内未完成。
    #[error("{formatter} 格式化超时（超过 {timeout_secs} 秒）。")]
    Timeout { formatter: String, timeout_secs: u64 },

    /// formatter 退出码非 0 且带 stderr 诊断。
    #[error("{formatter} 执行失败：{stderr}")]
    FormatterFailed { formatter: String, stderr: String },

    /// formatter 退出码非 0 但无 stderr 输出。
    #[error("{formatter} 执行失败。")]
    FormatterFailedSilent { formatter: String },

    /// formatter 输出不是合法 UTF-8。
    #[error("解析 {formatter} 输出失败：{message}")]
    OutputNotUtf8 { formatter: String, message: String },

    /// 行数 / 字符数超出 u32 表示范围。
    #[error("{label}超出支持范围。")]
    CountOverflow { label: String },
}

impl FormatErrorKind {
    /// 稳定错误码（带 `format.` 命名空间），前端据此分支。
    fn code(&self) -> &'static str {
        match self {
            Self::SpawnFailed { .. } => "format.spawn-failed",
            Self::StdinFailed { .. } => "format.stdin-failed",
            Self::RunFailed { .. } => "format.run-failed",
            Self::Timeout { .. } => "format.timeout",
            Self::FormatterFailed { .. } | Self::FormatterFailedSilent { .. } => {
                "format.formatter-failed"
            }
            Self::OutputNotUtf8 { .. } => "format.output-not-utf8",
            Self::CountOverflow { .. } => "format.count-overflow",
        }
    }
}

impl From<FormatErrorKind> for CommandError {
    fn from(kind: FormatErrorKind) -> Self {
        CommandError::new(kind.code(), kind.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_variants_to_namespaced_codes() {
        assert_eq!(
            FormatErrorKind::Timeout {
                formatter: "shfmt".into(),
                timeout_secs: 12,
            }
            .code(),
            "format.timeout"
        );
        assert_eq!(
            FormatErrorKind::SpawnFailed {
                formatter: "prettier".into(),
                message: "x".into(),
            }
            .code(),
            "format.spawn-failed"
        );
        assert_eq!(
            FormatErrorKind::FormatterFailedSilent {
                formatter: "biome".into(),
            }
            .code(),
            "format.formatter-failed"
        );
    }

    #[test]
    fn converts_into_command_error_preserving_code_and_message() {
        let command_error: CommandError = FormatErrorKind::FormatterFailed {
            formatter: "shfmt".into(),
            stderr: "boom".into(),
        }
        .into();
        assert_eq!(command_error.code, "format.formatter-failed");
        assert_eq!(command_error.message, "shfmt 执行失败：boom");
    }
}
