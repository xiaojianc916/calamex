//! 集成终端模块单元测试。

use std::fs;
use std::time::Duration;

use crate::terminal::{
    command_contracts::DispatchTerminalScriptRequest,
    dispatch::build_terminal_run_command_for_local_wsl,
    types::TerminalState,
    wsl as terminal_wsl,
};

use super::commands::wait_until_run_cleared;
use super::events::next_terminal_data_seq;
use super::state::{
    ActiveRunInputTarget, TerminalSessionState, active_terminal_run_count,
    buffer_pending_switch_input, clear_active_terminal_run, complete_session_run_state,
    get_active_terminal_run_input_target, get_session_state, set_session_state,
    take_and_prepend_pending_switch_input, try_mark_active_terminal_run,
};
use super::to_wsl_path;

#[test]
fn local_wsl_active_run_is_serialized_per_session() {
    let state = TerminalSessionState::default();
    assert!(try_mark_active_terminal_run(&state, "session-1", "run-1", Vec::new()).is_ok());
    assert!(try_mark_active_terminal_run(&state, "session-1", "run-2", Vec::new()).is_err());
    assert!(try_mark_active_terminal_run(&state, "session-2", "run-3", Vec::new()).is_ok());
    assert_eq!(active_terminal_run_count(&state), 2);
    clear_active_terminal_run(&state, "run-1");
    clear_active_terminal_run(&state, "run-3");
    assert_eq!(active_terminal_run_count(&state), 0);
    assert!(try_mark_active_terminal_run(&state, "session-1", "run-2", Vec::new()).is_ok());
    clear_active_terminal_run(&state, "run-2");
}

#[test]
fn active_run_does_not_block_input_outside_switching_states() {
    let state = TerminalSessionState::default();
    try_mark_active_terminal_run(&state, "session-1", "run-1", Vec::new())
        .expect("active run should mark");

    // 输入路由按「会话自身」的状态判定，不再读全局 registry().state；用每会话态驱动，
    // 避免与其它并行测试争抢共享的全局单例。会话从 Booting 基线走合法转移链。
    set_session_state(&state, "session-1", TerminalState::IdleInteractive);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::None)
    ));

    set_session_state(&state, "session-1", TerminalState::SwitchingToRun);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::Pending)
    ));

    set_session_state(&state, "session-1", TerminalState::Running);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-1"
    ));

    clear_active_terminal_run(&state, "run-1");
}

#[test]
fn active_run_input_routes_only_to_owning_session() {
    let state = TerminalSessionState::default();
    try_mark_active_terminal_run(&state, "session-A", "run-A", Vec::new())
        .expect("active run should mark");

    // 会话 A 自身走完整每会话转移进入 Running（不触碰全局，并行确定）。
    set_session_state(&state, "session-A", TerminalState::IdleInteractive);
    set_session_state(&state, "session-A", TerminalState::SwitchingToRun);
    set_session_state(&state, "session-A", TerminalState::Running);

    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-A"),
        Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-A"
    ));

    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-B"),
        Ok(ActiveRunInputTarget::None)
    ));

    clear_active_terminal_run(&state, "run-A");
}

#[test]
fn input_target_uses_per_session_state_not_global() {
    let state = TerminalSessionState::default();
    // 输入路由现在只依据「每会话各自的状态」，不再读全局 registry().state；本测试因此完全
    // 不触碰全局态，仅通过每会话态驱动断言，验证多开互不串台。
    try_mark_active_terminal_run(&state, "session-A", "run-A", Vec::new()).expect("mark A");
    try_mark_active_terminal_run(&state, "session-B", "run-B", Vec::new()).expect("mark B");

    // 会话 A 走完整每会话转移进入 Running。
    set_session_state(&state, "session-A", TerminalState::IdleInteractive);
    set_session_state(&state, "session-A", TerminalState::SwitchingToRun);
    set_session_state(&state, "session-A", TerminalState::Running);
    // 会话 B 仅处于交互态。
    set_session_state(&state, "session-B", TerminalState::IdleInteractive);

    // A 命中自身 Running -> 输入进 A 的 run。
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-A"),
        Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-A"
    ));
    // B 自身处于 IdleInteractive -> None：即便 A 在 Running、且 B 也有活动运行，
    // B 的输入也绝不串进任何 run（修复跨会话输入串台）。
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-B"),
        Ok(ActiveRunInputTarget::None)
    ));

    // B 自己进入 SwitchingToRun -> Pending（仅作用于 B，不影响 A）。
    set_session_state(&state, "session-B", TerminalState::SwitchingToRun);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-B"),
        Ok(ActiveRunInputTarget::Pending)
    ));
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-A"),
        Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-A"
    ));

    // 运行完成回收会话态：Running -> SwitchingToIdle -> IdleInteractive。
    complete_session_run_state(&state, "session-A");
    assert_eq!(
        get_session_state(&state, "session-A"),
        TerminalState::IdleInteractive
    );

    clear_active_terminal_run(&state, "run-A");
    clear_active_terminal_run(&state, "run-B");
}

#[test]
fn session_state_transitions_are_returned_for_emission() {
    let state = TerminalSessionState::default();
    // 无记录基线为 Booting：非法转移（Booting -> Running）被忽略，返回 None（不发事件）。
    assert!(set_session_state(&state, "emit-session", TerminalState::Running).is_none());
    // Booting -> IdleInteractive 合法，返回实际转移。
    assert_eq!(
        set_session_state(&state, "emit-session", TerminalState::IdleInteractive),
        Some((TerminalState::Booting, TerminalState::IdleInteractive))
    );
    // 相同态：无变化，返回 None。
    assert!(set_session_state(&state, "emit-session", TerminalState::IdleInteractive).is_none());
    // 进入运行链，逐跳返回实际转移。
    assert_eq!(
        set_session_state(&state, "emit-session", TerminalState::SwitchingToRun),
        Some((
            TerminalState::IdleInteractive,
            TerminalState::SwitchingToRun
        ))
    );
    assert_eq!(
        set_session_state(&state, "emit-session", TerminalState::Running),
        Some((TerminalState::SwitchingToRun, TerminalState::Running))
    );
    // 运行完成回收：Running -> SwitchingToIdle -> IdleInteractive，两步都按序返回。
    assert_eq!(
        complete_session_run_state(&state, "emit-session"),
        vec![
            (TerminalState::Running, TerminalState::SwitchingToIdle),
            (
                TerminalState::SwitchingToIdle,
                TerminalState::IdleInteractive
            ),
        ]
    );
    // 已回到 IdleInteractive，再次回收无转移、返回空。
    assert!(complete_session_run_state(&state, "emit-session").is_empty());
}

#[test]
fn pending_switch_input_is_buffered_and_prepended_not_dropped() {
    let state = TerminalSessionState::default();
    buffer_pending_switch_input(&state, "session-1", "ab").expect("buffer ok");
    buffer_pending_switch_input(&state, "session-1", "cd").expect("buffer ok");

    let combined = take_and_prepend_pending_switch_input(&state, "session-1", "EF".to_string())
        .expect("take ok");
    assert_eq!(combined, "abcdEF");

    let again = take_and_prepend_pending_switch_input(&state, "session-1", "X".to_string())
        .expect("take ok");
    assert_eq!(again, "X");
}

#[test]
fn terminal_data_seq_is_monotonic() {
    let first = next_terminal_data_seq();
    let second = next_terminal_data_seq();
    let third = next_terminal_data_seq();
    assert!(first < second);
    assert!(second < third);
}

#[test]
fn dispatch_command_prefers_workspace_root_over_script_directory() {
    let temp_root = std::env::temp_dir().join(format!(
        "calamex-dispatch-workspace-{}",
        terminal_wsl::build_temp_file_suffix().expect("suffix should build")
    ));
    let script_dir = temp_root.join("scripts");
    fs::create_dir_all(&script_dir).expect("test workspace should be created");
    let script_path = script_dir.join("hello.sh");
    fs::write(&script_path, "pwd\n").expect("test script should be written");
    let payload = DispatchTerminalScriptRequest {
        session_id: "dispatch-cwd-session".to_string(),
        path: Some(script_path.to_string_lossy().to_string()),
        workspace_root_path: Some(temp_root.to_string_lossy().to_string()),
        content: String::new(),
        is_dirty: false,
        run_id: "dispatch-cwd-run".to_string(),
    };
    let (command, script_content) = build_terminal_run_command_for_local_wsl(&payload, "/tmp")
        .expect("dispatch command should build");
    assert_eq!(
        command.working_directory,
        to_wsl_path(&temp_root).expect("workspace root should convert to WSL path")
    );
    assert!(script_content.is_none());
    let _ = fs::remove_dir_all(&temp_root);
}

#[test]
fn dirty_script_dispatch_keeps_inline_content_for_local_wsl() {
    let payload = DispatchTerminalScriptRequest {
        session_id: "dispatch-inline-session".to_string(),
        path: None,
        workspace_root_path: None,
        content: "echo __WSL_LINK_INLINE__\n".to_string(),
        is_dirty: true,
        run_id: "dispatch-inline-run".to_string(),
    };
    let (command, script_content) = build_terminal_run_command_for_local_wsl(&payload, "/tmp")
        .expect("dispatch command should build");
    assert_eq!(script_content.as_deref(), Some(payload.content.as_str()));
    assert!(command.used_temp_file);
    assert_eq!(command.cleanup_paths, vec![command.execution_path.clone()]);
}

#[test]
fn clearing_active_run_returns_registered_cleanup_paths() {
    let state = TerminalSessionState::default();
    // 登记带临时脚本的运行：clear 时应原样返回这些路径，供上层回收，根治 /tmp 泄漏。
    try_mark_active_terminal_run(
        &state,
        "cleanup-session",
        "cleanup-run",
        vec!["/tmp/calamex-untitled-123.tmp.sh".to_string()],
    )
    .expect("active run should mark");
    let cleaned = clear_active_terminal_run(&state, "cleanup-run");
    assert_eq!(
        cleaned,
        vec!["/tmp/calamex-untitled-123.tmp.sh".to_string()]
    );
    // 已移除：再次 clear 不存在的运行返回空列表（不 panic）。
    assert!(clear_active_terminal_run(&state, "cleanup-run").is_empty());
    assert_eq!(active_terminal_run_count(&state), 0);
}

#[tokio::test]
async fn cancel_escalation_watch_stops_once_run_is_cleared() {
    let state = TerminalSessionState::default();
    try_mark_active_terminal_run(&state, "cancel-session", "cancel-run", Vec::new())
        .expect("active run should mark");
    // 运行仍在：取消升级监护在短预算内应判定「未清理」(false)，从而继续升级。
    assert!(!wait_until_run_cleared(&state, "cancel-run", Duration::from_millis(150)).await);
    // 运行被 OSC 133 D 清理后：应立即判定「已清理」(true)，监护据此停止升级、不再多发信号。
    clear_active_terminal_run(&state, "cancel-run");
    assert!(wait_until_run_cleared(&state, "cancel-run", Duration::from_secs(2)).await);
}

#[test]
fn dispatch_command_prefixes_cd_to_working_directory() {
    let payload = DispatchTerminalScriptRequest {
        // ……按你现有测试的构造方式填充：指定 workspace_root_path / path
        ..Default::default()
    };
    let (command, _) =
        build_terminal_run_command_for_local_wsl(&payload, "/home/user").expect("build ok");
    assert!(
        command.display_command.starts_with("cd "),
        "运行命令应先 cd 到工作目录：{}",
        command.display_command
    );
    assert!(command.display_command.contains("&& /bin/bash "));
}
