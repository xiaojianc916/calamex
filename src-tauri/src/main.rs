mod commands;

use commands::{
    analyze_script, apply_window_stage, close_terminal_session, detect_execution_environment,
    dispatch_script_to_terminal, ensure_terminal_session, list_workspace_entries, load_image_asset,
    load_script, resize_terminal_session, run_script, save_script, show_startup_window,
    wait_for_terminal_run, write_terminal_input, TerminalSessionState,
};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalSessionState::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            apply_window_stage,
            show_startup_window,
            load_script,
            load_image_asset,
            save_script,
            analyze_script,
            detect_execution_environment,
            run_script,
            dispatch_script_to_terminal,
            wait_for_terminal_run,
            list_workspace_entries,
            ensure_terminal_session,
            write_terminal_input,
            resize_terminal_session,
            close_terminal_session
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SH editor");
}
