#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod ai_agent;
mod ai_context;
mod ai_index;
mod ai_patch;
mod ai_tools;
mod commands;
mod error;
mod terminal;

use commands::{
    ai_apply_patch, ai_build_index, ai_cancel, ai_chat, ai_chat_stream, ai_clear_credentials, ai_code_action, ai_get_config,
    ai_inline_complete, ai_list_tools, ai_plan_task, ai_propose_patch, ai_query_index,
    ai_save_config, ai_save_credentials, ai_test_provider, analyze_script, apply_window_stage,
    begin_startup_transition, cancel_terminal_run, close_terminal_session, commit_git_index,
    create_ssh_directory, create_workspace_path, delete_ssh_path, delete_workspace_path,
    detect_execution_environment, discard_git_paths, dispatch_script_to_terminal,
    download_ssh_file, ensure_terminal_session, finalize_startup_transition, format_script,
    get_git_file_baseline, get_git_repository_status, init_git_repository, list_ssh_config_hosts,
    list_ssh_directory, list_workspace_entries, load_image_asset, load_script, rename_ssh_path,
    rename_workspace_path, resize_terminal_session, save_script, search_workspace,
    set_window_background, shutdown_all_terminal_sessions, stage_git_paths, test_ssh_connection,
    unstage_git_paths, upload_ssh_file, write_terminal_input, TerminalSessionState,
};
use std::time::Duration;
use tauri::{Manager, WindowEvent};
use tokio::time::sleep;

#[cfg(windows)]
fn disable_webview_default_context_menu<R: tauri::Runtime>(
    webview_window: &tauri::WebviewWindow<R>,
) {
    let label = webview_window.label().to_string();
    let closure_label = label.clone();

    if let Err(error) = webview_window.with_webview(move |webview| unsafe {
        match webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false))
        {
            Ok(_) => {}
            Err(error) => {
                eprintln!(
                    "failed to disable default WebView2 context menu for window {closure_label}: {error}"
                );
            }
        }
    }) {
        eprintln!("failed to access platform webview for window {label}: {error}");
    }
}

#[cfg(not(windows))]
fn disable_webview_default_context_menu<R: tauri::Runtime>(
    _webview_window: &tauri::WebviewWindow<R>,
) {
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(TerminalSessionState::default())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let app_handle = window.app_handle();
                if window.label() == "main" {
                    let terminal_state = app_handle.state::<TerminalSessionState>();
                    if let Err(error) = shutdown_all_terminal_sessions(terminal_state.inner()) {
                        eprintln!("failed to shutdown terminal sessions: {error}");
                    }

                    app_handle.exit(0);
                }
            }
        })
        .setup(|app| {
            terminal::registry::registry()
                .event_bus
                .attach_app(app.handle().clone());

            for webview_window in app.webview_windows().into_values() {
                disable_webview_default_context_menu(&webview_window);
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
            }

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sleep(Duration::from_millis(1_500)).await;

                let main_visible = app_handle
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);

                let Some(welcome_window) = app_handle.get_webview_window("welcome") else {
                    return;
                };

                let welcome_visible = welcome_window.is_visible().unwrap_or(false);
                if welcome_visible || main_visible {
                    return;
                }

                let _ = welcome_window.show();
                let _ = welcome_window.set_focus();
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            apply_window_stage,
            set_window_background,
            begin_startup_transition,
            finalize_startup_transition,
            load_script,
            load_image_asset,
            save_script,
            analyze_script,
            format_script,
            detect_execution_environment,
            dispatch_script_to_terminal,
            list_workspace_entries,
            create_workspace_path,
            rename_workspace_path,
            delete_workspace_path,
            search_workspace,
            get_git_repository_status,
            init_git_repository,
            get_git_file_baseline,
            stage_git_paths,
            unstage_git_paths,
            discard_git_paths,
            commit_git_index,
            ensure_terminal_session,
            cancel_terminal_run,
            write_terminal_input,
            resize_terminal_session,
            close_terminal_session,
            test_ssh_connection,
            list_ssh_config_hosts,
            list_ssh_directory,
            download_ssh_file,
            upload_ssh_file,
            delete_ssh_path,
            rename_ssh_path,
            create_ssh_directory,
            ai_get_config,
            ai_save_config,
            ai_save_credentials,
            ai_clear_credentials,
            ai_test_provider,
            ai_chat,
            ai_chat_stream,
            ai_cancel,
            ai_inline_complete,
            ai_code_action,
            ai_plan_task,
            ai_build_index,
            ai_query_index,
            ai_propose_patch,
            ai_apply_patch,
            ai_list_tools
        ]);

    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("failed to run SH editor: {error}");
        std::process::exit(1);
    }
}
