//! LSP 数据结构与会话/管理器状态。

use std::{collections::HashMap, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    process::ChildStdin,
    sync::{Mutex, oneshot},
};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspDiagnostic {
    pub file_path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub severity: u32, // 1=Error, 2=Warning, 3=Info, 4=Hint
    pub message: String,
    pub code: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspCompletionItem {
    pub label: String,
    pub insert_text: Option<String>,
    pub kind: Option<u32>,
    pub detail: Option<String>,
    pub documentation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspHoverResult {
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LspContentChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<LspRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_length: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LspState {
    Stopped,
    Running,
}

pub(crate) type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

pub(crate) struct LspSession {
    pub(crate) state: LspState,
    pub(crate) stdin: Option<Arc<Mutex<ChildStdin>>>,
    pub(crate) next_id: i64,
    pub(crate) open_files: HashMap<String, String>, // path → uri
    pub(crate) workspace_root: Option<String>,
    /// 单调递增，每次 start +1。watcher 比对此值，避免在新一代实例上写状态。
    pub(crate) generation: u64,
    /// drop 即向 watcher 发出\"主动停止\"信号，使其不要再 emit `lsp-crashed`。
    pub(crate) kill_tx: Option<oneshot::Sender<()>>,
}

impl LspSession {
    pub(crate) fn new() -> Self {
        Self {
            state: LspState::Stopped,
            stdin: None,
            next_id: 1,
            open_files: HashMap::new(),
            workspace_root: None,
            generation: 0,
            kill_tx: None,
        }
    }
}

pub struct LspManager {
    pub(crate) session: Arc<Mutex<LspSession>>,
    pub(crate) pending: PendingMap,
    /// 串行化 `lsp_start` / `lsp_stop` 的整条生命周期路径。
    ///
    /// 参考 VS Code LanguageClient 的 start/stop guard：stop 不能在 start initialize
    /// 尚未写入 Running session 时提前 no-op，否则会留下刚启动的新进程。
    pub(crate) startup: Mutex<()>,
}

impl LspManager {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(LspSession::new())),
            pending: Arc::new(Mutex::new(HashMap::new())),
            startup: Mutex::new(()),
        }
    }
}
