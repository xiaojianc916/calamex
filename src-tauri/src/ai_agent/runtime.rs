pub enum AgentState {
    Idle,
    Planning,
    WaitingForConfirmation,
    RunningTool,
    GeneratingPatch,
    WaitingForApplyConfirmation,
    Completed,
    Failed,
    Cancelled,
}
