use serde::{Deserialize, Serialize};
use specta::Type;

// ============================================================================
// Workspace tree
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePathKind {
    Directory,
    File,
}

impl WorkspacePathKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Directory => "directory",
            Self::File => "file",
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub(crate) path: String,
    pub(crate) name: String,
    /// 已知值："file" | "directory" | "symlink" | …。
    pub(crate) kind: WorkspacePathKind,
    pub(crate) has_children: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryPayload {
    pub(crate) root_path: String,
    pub(crate) root_name: String,
    pub(crate) entries: Vec<WorkspaceEntry>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathCreateRequest {
    pub(crate) parent_path: String,
    pub(crate) root_path: String,
    pub(crate) name: String,
    /// 已知值："file" | "directory"。
    pub(crate) kind: WorkspacePathKind,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathCreatePayload {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) kind: WorkspacePathKind,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRenameRequest {
    pub(crate) path: String,
    pub(crate) root_path: String,
    pub(crate) new_name: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathRenamePayload {
    pub(crate) old_path: String,
    pub(crate) new_path: String,
    pub(crate) name: String,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathDeleteRequest {
    pub(crate) path: String,
    pub(crate) root_path: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathDeletePayload {
    pub(crate) path: String,
}
