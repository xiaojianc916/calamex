//! 集成终端模块单元测试。

use std::{fs, time::Duration};

use crate::terminal::{
    command_contracts::DispatchTerminalScriptRequest,
    dispatch::build_terminal_run_command_for_local_wsl,
    types::TerminalState,
    visual::{
        build_terminal_ansi_reset, build_terminal_run_separator,
        extract_prompt_from_terminal_snapshot, TerminalRunVisualTracker,
        TERMINAL_ANSI_EXIT_ALT_SCREEN, TERMINAL_ANSI_RESET_SCROLL_REGION_PRESERVE_CURSOR,
        TERMINAL_ANSI_SAFE_RESET,
    },
    wsl as terminal_wsl,
};

use super::events::{
    next_terminal_data_seq, next_terminal_run_chunk_seq, sanitize_terminal_run_chunk,
};
use super::state::{
    append_terminal_snapshot, buffer_pending_switch_input, clear_active_terminal_run,
    get_active_terminal_run_input_target, get_terminal_snapshot,
    mark_terminal_resize_repaint_suppression, set_terminal_snapshot,
    should_skip_snapshot_for_interactive_resize_repaint, take_and_prepend_pending_switch_input,
    try_mark_active_terminal_run, ActiveRunInputTarget, TerminalSessionState,
};
use super::to_wsl_path;

fn set_test_terminal_state(state: TerminalState) {
    let mut machine_state = crate::terminal::registry::registry()
        .state
        .write()
        .expect("terminal state lock should be healthy");
    *machine_state = state;
}

#[test]
fn local_wsl_active_run_is_serialized() {
    let state = TerminalSessionState::default();
    set_test_terminal_state(TerminalState::IdleInteractive);
    assert!(try_mark_active_terminal_run(&state, "session-1", "run-1").is_ok());
    assert!(try_mark_active_terminal_run(&state, "session-1", "run-2").is_err());
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::None)
    ));
    clear_active_terminal_run(&state, "run-1");
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::None)
    ));
    assert!(try_mark_active_terminal_run(&state, "session-1", "run-2").is_ok());
}

#[test]
fn active_run_does_not_block_input_outside_switching_states() {
    let state = TerminalSessionState::default();
    try_mark_active_terminal_run(&state, "session-1", "run-1").expect("active run should mark");

    set_test_terminal_state(TerminalState::IdleInteractive);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::None)
    ));

    set_test_terminal_state(TerminalState::SwitchingToRun);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::Pending)
    ));

    set_test_terminal_state(TerminalState::Running);
    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-1"),
        Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-1"
    ));

    set_test_terminal_state(TerminalState::IdleInteractive);
}

#[test]
fn active_run_input_routes_only_to_owning_session() {
    let state = TerminalSessionState::default();
    try_mark_active_terminal_run(&state, "session-A", "run-A").expect("active run should mark");
    set_test_terminal_state(TerminalState::Running);

    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-A"),
        Ok(ActiveRunInputTarget::Run(run_id)) if run_id == "run-A"
    ));

    assert!(matches!(
        get_active_terminal_run_input_target(&state, "session-B"),
        Ok(ActiveRunInputTarget::None)
    ));

    set_test_terminal_state(TerminalState::IdleInteractive);
}

#[test]
fn pending_switch_input_is_buffered_and_prepended_not_dropped() {
    let state = TerminalSessionState::default();
    buffer_pending_switch_input(&state, "session-1", "ab").expect("buffer ok");
    buffer_pending_switch_input(&state, "session-1", "cd").expect("buffer ok");

    let combined =
        take_and_prepend_pending_switch_input(&state, "session-1", "EF".to_string())
            .expect("take ok");
    assert_eq!(combined, "abcdEF");

    let again = take_and_prepend_pending_switch_input(&state, "session-1", "X".to_string())
        .expect("take ok");
    assert_eq!(again, "X");
}

#[test]
fn terminal_run_chunk_seq_is_monotonic() {
    let first = next_terminal_run_chunk_seq();
    let second = next_terminal_run_chunk_seq();
    let third = next_terminal_run_chunk_seq();
    assert!(first < second);
    assert!(second < third);
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
fn terminal_run_visual_separator_does_not_add_blank_line_after_newline_output() {
    let separator = build_terminal_run_separator(
        7,
        Some(0),
        Duration::from_millis(1200),
        TerminalRunVisualTracker {
            has_output: true,
            ended_at_line_start: true,
            ..TerminalRunVisualTracker::default()
        },
        Some("[test@Predator ~]$ ".to_string()),
    );
    assert!(separator.starts_with("──── run #7 · exit 0 · 1.2s ────\r\n"));
    assert!(separator.ends_with("[test@Predator ~]$ "));
    assert!(!separator.starts_with("\r\n\r\n"));
}

#[test]
fn terminal_run_visual_separator_starts_newline_for_no_newline_output() {
    let separator = build_terminal_run_separator(
        8,
        Some(42),
        Duration::from_millis(250),
        TerminalRunVisualTracker {
            has_output: true,
            ended_at_line_start: false,
            ..TerminalRunVisualTracker::default()
        },
        None,
    );
    assert!(separator.starts_with("\r\n──── run #8 · exit 42 · 0.2s ────\r\n"));
}

#[test]
fn visual_reset_does_not_move_cursor_for_plain_output() {
    let mut tracker = TerminalRunVisualTracker::default();
    tracker.observe("Hello SH Editor\n");
    let reset = build_terminal_ansi_reset(tracker);
    assert!(!reset.contains("\x1b[?1049l"));
    assert!(!reset.contains("\x1b[r"));
    assert_eq!(reset, TERMINAL_ANSI_SAFE_RESET);
}

#[test]
fn visual_reset_exits_alt_screen_only_when_run_entered_it() {
    let mut tracker = TerminalRunVisualTracker::default();
    tracker.observe("\x1b[?1049hinside alt screen");
    let reset = build_terminal_ansi_reset(tracker);
    assert!(reset.starts_with(TERMINAL_ANSI_EXIT_ALT_SCREEN));
}

#[test]
fn visual_reset_preserves_cursor_when_resetting_scroll_region() {
    let mut tracker = TerminalRunVisualTracker::default();
    tracker.observe("\x1b[3;20rregion changed");
    let reset = build_terminal_ansi_reset(tracker);
    assert!(reset.contains(TERMINAL_ANSI_RESET_SCROLL_REGION_PRESERVE_CURSOR));
    assert!(!reset.contains("\x1b[m\x1b[r"));
}

#[test]
fn interactive_resize_repaint_is_excluded_from_snapshot_window() {
    let state = TerminalSessionState::default();
    let session_id = "resize-repaint-session";
    mark_terminal_resize_repaint_suppression(&state, session_id);
    assert!(should_skip_snapshot_for_interactive_resize_repaint(
        &state,
        session_id,
        "\x1b[?25l\x1b[m\x1b[HTo run a command as administrator\x1b[K\r\n[test@Predator]$\x1b[K"
    ));
    assert!(!should_skip_snapshot_for_interactive_resize_repaint(
        &state,
        session_id,
        "normal output after resize\r\n"
    ));
}

#[test]
fn interactive_resize_repaint_keeps_alt_screen_frames() {
    let state = TerminalSessionState::default();
    let session_id = "resize-alt-screen-session";
    mark_terminal_resize_repaint_suppression(&state, session_id);
    assert!(!should_skip_snapshot_for_interactive_resize_repaint(
        &state,
        session_id,
        "\x1b[?1049h"
    ));
    mark_terminal_resize_repaint_suppression(&state, session_id);
    assert!(!should_skip_snapshot_for_interactive_resize_repaint(
        &state,
        session_id,
        "\x1b[?25l\x1b[Hvim repaint\x1b[K"
    ));
}

#[test]
fn terminal_run_extracts_last_prompt_from_interactive_snapshot() {
    let snapshot = "To run a command as administrator\n\x1b[4;1H\x1b[?25h\x1b[?2004h\x1b[32m\x1b[1m[test@Predator my_desktop_app]$\x1b[m ";
    let prompt = extract_prompt_from_terminal_snapshot(snapshot);
    assert_eq!(
        prompt.as_deref(),
        Some("\x1b[32m\x1b[1m[test@Predator my_desktop_app]$\x1b[m ")
    );
}

#[test]
fn visual_completion_snapshot_keeps_prompt_after_run_chunk_with_dollar() {
    let state = TerminalSessionState::default();
    let session_id = "snapshot-prompt-session";
    let prompt = "\x1b[32m\x1b[1m[test@Predator my_desktop_app]$\x1b[m ";
    set_terminal_snapshot(&state, session_id, prompt.to_string()).expect("snapshot set");
    append_terminal_snapshot(&state, session_id, "price is $5\n").expect("run output append");
    let separator = build_terminal_run_separator(
        9,
        Some(0),
        Duration::from_millis(900),
        TerminalRunVisualTracker {
            has_output: true,
            ended_at_line_start: true,
            ..TerminalRunVisualTracker::default()
        },
        Some(prompt.to_string()),
    );
    append_terminal_snapshot(&state, session_id, &separator).expect("separator append");
    let snapshot = get_terminal_snapshot(&state, session_id).expect("snapshot get");
    let extracted = extract_prompt_from_terminal_snapshot(&snapshot);
    assert_eq!(extracted.as_deref(), Some(prompt));
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
fn run_chunk_strips_leading_conpty_screen_clear_on_first_output() {
    let cleaned = sanitize_terminal_run_chunk("\x1b[2J\x1b[H\x1b[3;1Hclimate report\r\n", false);
    assert_eq!(cleaned, "climate report\r\n");
}

#[test]
fn run_chunk_strips_repeated_wsl_diagnostic_banner() {
    let raw = "wsl: 检测到 localhost 代理配置，但未镜像到 WSL。\r\nclimate report\r\n";
    let cleaned = sanitize_terminal_run_chunk(raw, false);
    assert_eq!(cleaned, "climate report\r\n");
}

#[test]
fn run_chunk_keeps_plain_output_and_dollar_signs() {
    let raw = "total price is $5\n";
    assert_eq!(sanitize_terminal_run_chunk(raw, true), raw);
    assert_eq!(sanitize_terminal_run_chunk(raw, false), raw);
}

#[test]
fn run_chunk_does_not_strip_leading_newline_without_control_prefix() {
    // 脚本自身的前导空行必须保留（没有屏幕初始化控制序列时不处理）。
    let raw = "\r\nfirst real line\r\n";
    assert_eq!(sanitize_terminal_run_chunk(raw, false), raw);
}

#[test]
fn run_chunk_preserves_alt_screen_entry_for_tui_programs() {
    // 进入 alt-screen 的 TUI（如 vim）首字节是 ?1049h，不应被当作屏幕初始化剥除。
    let raw = "\x1b[?1049h\x1b[2J\x1b[Hvim ui";
    assert_eq!(sanitize_terminal_run_chunk(raw, false), raw);
}

#[test]
fn run_chunk_banner_strip_only_targets_line_start() {
    // 行中出现 "wsl:" 不应被删除（仅整行以 wsl: 开头才视作横幅）。
    let raw = "see docs at wsl: not a banner\r\n";
    assert_eq!(sanitize_terminal_run_chunk(raw, true), raw);
}
