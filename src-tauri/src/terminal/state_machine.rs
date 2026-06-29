use super::types::TerminalState;

/// 终端状态转移的合法性判定(每会话 FSM 的唯一约束源)。每会话状态直接存于
/// PerSessionState.state,转移前以本静态判定校验合法性;旧的实例状态机(new/state/
/// transition)与 run 不变量校验已随单命令模型移除。
pub struct StateMachine;

impl StateMachine {
    pub fn can_transition(from: TerminalState, to: TerminalState) -> bool {
        matches!(
            (from, to),
            (TerminalState::Booting, TerminalState::IdleInteractive)
                | (TerminalState::IdleInteractive, TerminalState::SwitchingToRun)
                | (TerminalState::SwitchingToRun, TerminalState::Running)
                | (TerminalState::SwitchingToRun, TerminalState::IdleInteractive)
                | (TerminalState::Running, TerminalState::SwitchingToIdle)
                | (TerminalState::SwitchingToIdle, TerminalState::IdleInteractive)
                | (TerminalState::IdleInteractive, TerminalState::Booting)
        )
    }
}
