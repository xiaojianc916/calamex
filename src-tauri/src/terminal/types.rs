#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TerminalState {
    Booting,
    IdleInteractive,
    SwitchingToRun,
    Running,
    SwitchingToIdle,
}

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
