use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// 通用多语言格式化契约（External 子进程 formatter）
//
// 对齐 ADR-0008：前端用 resolveLanguageForPath 解析 languageId 后调用
// format_document；后端按语言解析「专用 External formatter」并经子进程
// stdin/stdout 执行。后端独占 formatter 注册表与发现策略（满足「系统能力
// 必经 Rust 命令」），前端不传任意命令。
//
// 本契约只承载文本：编码（DocumentEncoding）属于保存阶段的关注点，由
// save_script 链路单独处理，格式化执行层不感知编码，保持职责单一。
// ============================================================================

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatDocumentRequest {
    /// 待格式化的全文。
    pub(crate) content: String,
    /// 由前端 resolveLanguageForPath 解析出的语言 id（如 "shell" / "typescript" / "python"）。
    pub(crate) language_id: String,
    /// 可选文件路径，供 formatter 选择 parser / 读取就近配置（如 prettier 按文件名）。
    pub(crate) path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatDocumentPayload {
    /// 格式化后的全文；未命中可用 formatter 时原样回传入参 content。
    pub(crate) content: String,
    /// 实际使用的 formatter id（如 "shfmt" / "prettier" / "biome"）。
    /// None 表示该语言无专用 External formatter 或未发现可用二进制，
    /// 前端据此退回 whitespace 归一。
    pub(crate) formatter_id: Option<String>,
    pub(crate) line_count: u32,
    pub(crate) char_count: u32,
}
