use std::fmt;

use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Script payloads
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum DocumentEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "gbk")]
    Gbk,
    #[serde(rename = "gb18030")]
    Gb18030,
    #[serde(rename = "utf-16le")]
    Utf16le,
    #[serde(rename = "utf-16be")]
    Utf16be,
}

impl DocumentEncoding {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf8Bom => "utf-8-bom",
            Self::Gbk => "gbk",
            Self::Gb18030 => "gb18030",
            Self::Utf16le => "utf-16le",
            Self::Utf16be => "utf-16be",
        }
    }
}

impl fmt::Display for DocumentEncoding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ScriptDiagnosticSeverity {
    Error,
    Warning,
    Info,
    Style,
}

impl TryFrom<&str> for ScriptDiagnosticSeverity {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, String> {
        match value {
            "error" => Ok(Self::Error),
            "warning" => Ok(Self::Warning),
            "info" => Ok(Self::Info),
            "style" => Ok(Self::Style),
            other => Err(format!("ShellCheck 返回了未知诊断级别：{other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptFilePayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) encoding: DocumentEncoding,
    pub(crate) line_count: u32,
    pub(crate) char_count: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetPayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) mime_type: String,
    pub(crate) byte_size: u32,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveScriptRequest {
    pub(crate) path: String,
    pub(crate) content: String,
    /// 若来自工作区文件树 / 会话恢复 / 工作区批处理，必须传入工作区根并由后端校验路径边界。
    /// 通过系统文件选择器打开或另存为的单文件可为空，保留用户显式选择任意本地文件的能力。
    pub(crate) workspace_root_path: Option<String>,
    /// 文本编码，已知值："utf-8" | "utf-8-bom" | "gbk" | …（保持字符串以便扩展）。
    pub(crate) encoding: DocumentEncoding,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatScriptRequest {
    pub(crate) path: Option<String>,
    pub(crate) content: String,
    /// 文本编码，已知值："utf-8" | "utf-8-bom" | "gbk" | …。
    pub(crate) encoding: DocumentEncoding,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatScriptPayload {
    pub(crate) content: String,
    pub(crate) encoding: DocumentEncoding,
    pub(crate) line_count: u32,
    pub(crate) char_count: u32,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptRequest {
    pub(crate) path: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) content: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptDiagnosticPayload {
    pub(crate) line: u32,
    pub(crate) end_line: u32,
    pub(crate) column: u32,
    pub(crate) end_column: u32,
    pub(crate) level: ScriptDiagnosticSeverity,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzeScriptPayload {
    pub(crate) available: bool,
    pub(crate) message: Option<String>,
    pub(crate) dialect: String,
    pub(crate) diagnostics: Vec<ScriptDiagnosticPayload>,
}

// ============================================================================
// Execution environment
// ============================================================================

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorKind {
    Wsl,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOption {
    pub(crate) r#type: ExecutorKind,
    pub(crate) label: String,
    pub(crate) available: bool,
    pub(crate) description: String,
    pub(crate) command_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEnvironment {
    pub(crate) recommended: ExecutorKind,
    pub(crate) has_any: bool,
    pub(crate) executors: Vec<ExecutionOption>,
}
