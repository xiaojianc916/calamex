use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Deserialize, Type)]
pub enum WorkspaceSearchScope {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "file-name")]
    FileName,
    #[serde(rename = "symbol")]
    Symbol,
    #[serde(rename = "content")]
    Content,
}

impl WorkspaceSearchScope {
    pub(super) fn includes_file_name(&self) -> bool {
        matches!(self, Self::All | Self::FileName)
    }

    pub(super) fn includes_content(&self) -> bool {
        matches!(self, Self::All | Self::Content)
    }

    pub(super) fn includes_symbol(&self) -> bool {
        matches!(self, Self::All | Self::Symbol)
    }

    pub(super) fn is_all(&self) -> bool {
        matches!(self, Self::All)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub enum WorkspaceSearchResultKind {
    #[serde(rename = "file-name")]
    FileName,
    #[serde(rename = "content")]
    Content,
    #[serde(rename = "symbol")]
    Symbol,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchRequest {
    pub(crate) workspace_root_path: String,
    pub(crate) query: String,
    pub(crate) scope: WorkspaceSearchScope,
    pub(crate) match_case: bool,
    pub(crate) whole_word: bool,
    pub(crate) use_regex: bool,
    #[serde(default)]
    pub(crate) use_structural: bool,
    // 仅作用于内容搜索：开启后内容改用 nucleo 子序列模糊匹配（默认精确/正则）。
    // 与 use_regex / whole_word 互斥：开启模糊时这两项被忽略（前端也会关闭正则）。
    #[serde(default)]
    pub(crate) content_fuzzy: bool,
    #[serde(default)]
    pub(crate) include_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_patterns: Vec<String>,
    pub(crate) limit: Option<u32>,
    // 内容搜索流式推送的关联标识：非 None 时后端会按发现顺序通过
    // WorkspaceSearchStreamEvent 分批推送内容命中，事件里回带这个 search_id，
    // 让前端把分批结果对应到当前在途请求；None 表示沿用一次性返回。
    #[serde(default)]
    pub(crate) stream_token: Option<u32>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchPayload {
    pub(crate) root_path: String,
    pub(crate) scanned_file_count: u32,
    pub(crate) results: Vec<WorkspaceSearchResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) name: String,
    pub(crate) kind: WorkspaceSearchResultKind,
    pub(crate) line_number: Option<u32>,
    pub(crate) line_text: Option<String>,
    pub(crate) match_start: Option<u32>,
    pub(crate) match_end: Option<u32>,
    pub(crate) score: i32,
}

/// 内容搜索流式推送事件。
///
/// 仿照 workspace_watcher::WorkspaceFsEvent，通过手动 impl tauri_specta::Event 让该类型
/// 既出现在生成的 TS 绑定 events.workspaceSearchStreamEvent 中，又提供类型化的 .emit(app)。
/// 事件名固定为 workspace-search-stream。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchStreamEvent {
    /// 关联的请求标识，对应 WorkspaceSearchRequest.stream_token；前端据此对账当前在途搜索。
    pub search_id: u32,
    /// 解析后的工作区根目录绝对路径。
    pub root_path: String,
    /// 本批次的内容命中（按发现顺序，未做全局排序）。
    pub results: Vec<WorkspaceSearchResult>,
}

impl tauri_specta::Event for WorkspaceSearchStreamEvent {
    const NAME: &'static str = "workspace-search-stream";
}

#[derive(Debug, Deserialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementRequest {
    pub(crate) workspace_root_path: String,
    pub(crate) query: String,
    pub(crate) replacement: String,
    pub(crate) match_case: bool,
    pub(crate) whole_word: bool,
    pub(crate) use_regex: bool,
    #[serde(default)]
    pub(crate) use_structural: bool,
    #[serde(default)]
    pub(crate) include_patterns: Vec<String>,
    #[serde(default)]
    pub(crate) exclude_patterns: Vec<String>,
    pub(crate) limit: Option<u32>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementExpectedFile {
    pub(crate) path: String,
    pub(crate) before_hash: String,
    #[serde(default)]
    pub(crate) included_match_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementApplyRequest {
    pub(crate) request: WorkspaceReplacementRequest,
    pub(crate) expected_files: Vec<WorkspaceReplacementExpectedFile>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementPreviewPayload {
    pub(crate) root_path: String,
    pub(crate) file_count: u32,
    pub(crate) replacement_count: u32,
    pub(crate) files: Vec<WorkspaceReplacementFilePreview>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementFilePreview {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) replacement_count: u32,
    pub(crate) before_hash: String,
    pub(crate) after_hash: String,
    pub(crate) diff: String,
    pub(crate) diff_truncated: bool,
    pub(crate) line_previews: Vec<WorkspaceReplacementLinePreview>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementLinePreview {
    pub(crate) id: String,
    pub(crate) line_number: u32,
    /// 命中所在行（已去掉行首缩进、未拼省略号）。
    pub(crate) before_line: String,
    /// 替换文本（前端据此构建 after 段与新增 diff）。
    pub(crate) inserted_text: String,
    /// 命中区间在 before_line 中的起止（UTF-16 code unit 偏移）。
    pub(crate) match_start: u32,
    pub(crate) match_end: u32,
    /// 仅当超过安全上限、对应一侧有内容被丢弃时为真（前端据此渲染数据级省略号）。
    pub(crate) truncated_start: bool,
    pub(crate) truncated_end: bool,
    pub(crate) replacement_count: u32,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementApplyPayload {
    pub(crate) root_path: String,
    pub(crate) changed_file_count: u32,
    pub(crate) replacement_count: u32,
    pub(crate) files: Vec<WorkspaceReplacementAppliedFile>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplacementAppliedFile {
    pub(crate) path: String,
    pub(crate) relative_path: String,
    pub(crate) replacement_count: u32,
    pub(crate) byte_size: u32,
}
