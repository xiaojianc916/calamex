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

#[derive(Debug, Clone, Serialize, Type)]
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
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchPayload {
    pub(crate) root_path: String,
    pub(crate) scanned_file_count: u32,
    pub(crate) results: Vec<WorkspaceSearchResult>,
}

#[derive(Debug, Serialize, Type)]
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
    pub(crate) before_line: String,
    pub(crate) after_line: String,
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
