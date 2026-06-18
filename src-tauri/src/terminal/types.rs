use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalState {
    Booting,
    IdleInteractive,
    SwitchingToRun,
    Running,
    SwitchingToIdle,
}

pub type RunId = String;
pub type SessionId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Geometry {
    pub cols: u16,
    pub rows: u16,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 40,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum DataSource {
    Interactive,
    Run { run_id: RunId },
    InjectedReset,
    InjectedSeparator,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalDataPayload {
    pub source: DataSource,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunChunkPayload {
    pub run_id: RunId,
    pub seq: u64,
    pub data: Vec<u8>,
    pub ts_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunStartedPayload {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub started_at_ms: i64,
    pub pid: u32,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunCompletedPayload {
    pub run_id: RunId,
    pub exit_code: Option<i32>,
    pub duration_ms: i64,
    pub reason: CompletionReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionReason {
    Exited,
    Signaled,
    Killed,
    SessionClosed,
    SpawnFailedLate,
    Lost,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StateChangedPayload {
    pub from: TerminalState,
    pub to: TerminalState,
    pub at_ms: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RunHandle {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub started_at_ms: i64,
    pub pid: u32,
}

#[derive(Debug, Clone)]
pub struct RunSpec {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub cwd: String,
    pub script_path: Option<String>,
    pub inline_content: Option<String>,
    pub extra_env: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelMode {
    Graceful,
    Kill,
}
