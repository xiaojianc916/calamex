#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_sidecar;
mod ai;
mod assets;
#[macro_use]
mod commands;
mod tauri_bindings;
mod terminal;
mod wsl_link;

use ai::edit::AiEditState;
use commands::{
    agent_sidecar_chat, agent_sidecar_execute, agent_sidecar_health, agent_sidecar_plan,
    agent_sidecar_plan_approve, agent_sidecar_plan_finish, agent_sidecar_plan_query,
    agent_sidecar_plan_reject, agent_sidecar_plan_replan, agent_sidecar_plan_validate,
    agent_sidecar_resolve_approval, agent_sidecar_restart, agent_sidecar_restore_checkpoint,
    agent_sidecar_warmup, ai_agent_classify_task, ai_agent_set_network_permission, ai_apply_patch,
    ai_cancel, ai_chat_stream, ai_clear_credentials, ai_code_action, ai_connect_provider,
    ai_edit_create_snapshot, ai_edit_get_auth_level, ai_edit_get_diff, ai_edit_list_timeline,
    ai_edit_restore_snapshot, ai_edit_revert_file, ai_edit_revert_hunk, ai_edit_revert_task,
    ai_edit_set_auth_level, ai_edit_set_pin, ai_edit_undo_operation,
    ai_generate_conversation_title, ai_generate_suggestion_pool, ai_get_config,
    ai_get_suggestion_pool_cache, ai_inline_complete, ai_propose_patch, ai_save_config,
    ai_save_credentials, ai_test_provider, ai_test_provider_config, ai_web_fetch, ai_web_search,
    analyze_script, apply_git_stash, apply_window_stage, apply_workspace_replacement,
    cancel_terminal_run, check_wsl_link_environment, checkout_git_branch, close_terminal_session,
    commit_git_index, create_git_branch, create_ssh_directory, create_workspace_path,
    delete_ssh_path, delete_workspace_path, detect_execution_environment, discard_git_paths,
    dispatch_script_to_terminal, download_ssh_file, drop_git_stash, ensure_terminal_session,
    format_script, get_git_diff_preview, get_git_file_baseline, get_git_pull_request_support,
    get_git_repository_status, get_ssh_password, get_wsl_link_agent_artifact_status,
    get_wsl_link_status, init_git_repository, install_wsl_link_agent, list_git_branches,
    list_git_commit_history, list_git_stashes, list_ssh_config_hosts, list_ssh_directory,
    list_workspace_entries, load_image_asset, load_script, preview_workspace_replacement,
    probe_wsl_link_primary, read_ssh_file, rename_ssh_path, rename_workspace_path,
    resize_terminal_session, save_git_stash, save_script, save_ssh_password, search_workspace,
    set_window_background, shutdown_all_terminal_sessions, stage_git_paths, start_wsl_link_agent,
    start_wsl_link_supervisor, stop_wsl_link_supervisor, test_ssh_connection, unstage_git_paths,
    upload_ssh_file, write_ssh_file, write_terminal_input, TerminalSessionState,
};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use wsl_link::runtime::WslLinkRuntimeState;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_ICON_ID: &str = "main-tray";
const TRAY_MENU_SHOW_ID: &str = "tray.show-main-window";
const TRAY_MENU_QUIT_ID: &str = "tray.quit-app";
const TRAY_TOOLTIP: &str = "Calamex";

// === 启动日志 ============================================================
fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn emit_startup_event(event: &str, app_started_at: Instant) {
    eprintln!(
        "{}",
        serde_json::json!({
            "level": "info",
            "scope": "startup",
            "event": event,
            "elapsedMs": elapsed_ms(app_started_at),
        })
    );
}

fn emit_startup_step(event: &str, app_started_at: Instant, step_started_at: Instant) {
    eprintln!(
        "{}",
        serde_json::json!({
            "level": "info",
            "scope": "startup",
            "event": event,
            "elapsedMs": elapsed_ms(app_started_at),
            "durationMs": elapsed_ms(step_started_at),
        })
    );
}

macro_rules! timed_step {
    ($event:expr, $app_started_at:expr, $body:block) => 
        let __step_started_at = std::time::Instant::now();
        let __result = $body;
        emit_startup_step($event, $app_started_at, __step_started_at);
        __result;
}

// === 生命周期 ============================================================
#[derive(Default)]
struct AppLifecycleState {
    is_quitting: AtomicBool,
}

impl AppLifecycleState {
    fn mark_quitting(&self) {
        self.is_quitting.store(true, Ordering::SeqCst);
    }
    fn is_quitting(&self) -> bool {
        self.is_quitting.load(Ordering::SeqCst)
    }
}

fn reveal_main_window<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn request_app_exit<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    app_handle.state::<AppLifecycleState>().mark_quitting();

    let terminal_state = app_handle.state::<TerminalSessionState>();
    if let Err(error) = shutdown_all_terminal_sessions(terminal_state.inner()) {
        eprintln!("failed to shutdown terminal sessions: {error}");
    }
    app_handle.exit(0);
}

// === 系统托盘 ============================================================
fn setup_system_tray<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id(TRAY_MENU_SHOW_ID, "显示主窗口").build(app)?;
    let quit_item = MenuItemBuilder::with_id(TRAY_MENU_QUIT_ID, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("missing default window icon, tray setup skipped");
        return Ok(());
    };

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(icon)
        .tooltip(TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            // 改动 3: 用 match 替代连续 if，新增菜单项时分支显式可见
            TRAY_MENU_SHOW_ID => reveal_main_window(app_handle),
            TRAY_MENU_QUIT_ID => request_app_exit(app_handle),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// === WebView 平台相关 ====================================================
// 改动 4: 简化 label 二次 clone；用 Cow / 直接拥有 String 给闭包
#[cfg(windows)]
fn disable_webview_default_context_menu<R: tauri::Runtime>(
    webview_window: &tauri::WebviewWindow<R>,
) {
    let label = webview_window.label().to_string();
    let label_for_inner = label.clone();
    let access_result = webview_window.with_webview(move |webview| unsafe {
        let outcome = webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|settings| settings.SetAreDefaultContextMenusEnabled(false));
        if let Err(error) = outcome {
            eprintln!(
                "failed to disable default WebView2 context menu for window {label_for_inner}: {error}"
            );
        }
    });
    if let Err(error) = access_result {
        eprintln!("failed to access platform webview for window {label}: {error}");
    }
}

#[cfg(not(windows))]
fn disable_webview_default_context_menu<R: tauri::Runtime>(
    _webview_window: &tauri::WebviewWindow<R>,
) {
}

// === main ================================================================
fn main() {
    let app_started_at = Instant::now();
    emit_startup_event("tauri.main.start", app_started_at);

    // 改动 5: tauri_bindings 仅在 debug 模式生成与导出，避免 release 下 unused 警告
    #[cfg(debug_assertions)]
    {
        let bindings = tauri_bindings::builder();
        tauri_bindings::export(&bindings);
    }

    let builder_started_at = Instant::now();
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("favicon", |context, request, responder| {
            let app_handle = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let response = assets::favicon::handle_protocol_request(&app_handle, request).await;
                responder.respond(response);
            });
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AiEditState::default())
        .manage(AppLifecycleState::default())
        .manage(TerminalSessionState::default())
        .manage(WslLinkRuntimeState::default())
        .on_window_event(|window, event| {
            // 改动 6: 提前 return 减少嵌套；只对 main 窗口拦截关闭
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            let app_handle = window.app_handle();
            if app_handle.state::<AppLifecycleState>().is_quitting() {
                return;
            }
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("failed to hide main window to tray: {error}");
            }
        })
        .setup(move |app| {
            let setup_started_at = Instant::now();
            emit_startup_event("tauri.setup.start", app_started_at);

            timed_step!("tauri.setup.terminal-events-attached", app_started_at, {
                terminal::registry::registry()
                    .event_bus
                    .attach_app(app.handle().clone());
            });

            // setup_system_tray 返回 Result，用 ? 跳出 setup
            let tray_started_at = Instant::now();
            setup_system_tray(app)?;
            emit_startup_step("tauri.setup.tray-ready", app_started_at, tray_started_at);

            timed_step!("tauri.setup.webview-settings-ready", app_started_at, {
                for webview_window in app.webview_windows().into_values() {
                    disable_webview_default_context_menu(&webview_window);
                }
            });

            timed_step!("tauri.setup.window-state-ready", app_started_at, {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    let _ = window.unminimize();
                }
            });

            emit_startup_step("tauri.setup.done", app_started_at, setup_started_at);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            apply_window_stage,
            set_window_background,
            load_script,
            load_image_asset,
            save_script,
            analyze_script,
            format_script,
            detect_execution_environment,
            get_wsl_link_status,
            check_wsl_link_environment,
            get_wsl_link_agent_artifact_status,
            install_wsl_link_agent,
            start_wsl_link_agent,
            start_wsl_link_supervisor,
            stop_wsl_link_supervisor,
            probe_wsl_link_primary,
            dispatch_script_to_terminal,
            list_workspace_entries,
            create_workspace_path,
            rename_workspace_path,
            delete_workspace_path,
            search_workspace,
            preview_workspace_replacement,
            apply_workspace_replacement,
            get_git_repository_status,
            init_git_repository,
            list_git_commit_history,
            list_git_branches,
            checkout_git_branch,
            create_git_branch,
            get_git_file_baseline,
            get_git_diff_preview,
            stage_git_paths,
            unstage_git_paths,
            discard_git_paths,
            commit_git_index,
            list_git_stashes,
            save_git_stash,
            apply_git_stash,
            drop_git_stash,
            get_git_pull_request_support,
            ensure_terminal_session,
            cancel_terminal_run,
            write_terminal_input,
            resize_terminal_session,
            close_terminal_session,
            agent_sidecar_health,
            agent_sidecar_chat,
            agent_sidecar_plan,
            agent_sidecar_plan_approve,
            agent_sidecar_plan_query,
            agent_sidecar_plan_reject,
            agent_sidecar_plan_finish,
            agent_sidecar_plan_validate,
            agent_sidecar_plan_replan,
            agent_sidecar_execute,
            agent_sidecar_resolve_approval,
            agent_sidecar_restart,
            agent_sidecar_restore_checkpoint,
            agent_sidecar_warmup,
            test_ssh_connection,
            save_ssh_password,
            get_ssh_password,
            list_ssh_config_hosts,
            list_ssh_directory,
            download_ssh_file,
            upload_ssh_file,
            read_ssh_file,
            write_ssh_file,
            delete_ssh_path,
            rename_ssh_path,
            create_ssh_directory,
            ai_get_config,
            ai_save_config,
            ai_save_credentials,
            ai_clear_credentials,
            ai_test_provider,
            ai_test_provider_config,
            ai_connect_provider,
            ai_generate_conversation_title,
            ai_get_suggestion_pool_cache,
            ai_generate_suggestion_pool,
            ai_chat_stream,
            ai_cancel,
            ai_inline_complete,
            ai_code_action,
            ai_agent_classify_task,
            ai_agent_set_network_permission,
            ai_web_search,
            ai_web_fetch,
            ai_propose_patch,
            ai_apply_patch,
            ai_edit_get_auth_level,
            ai_edit_set_auth_level,
            ai_edit_list_timeline,
            ai_edit_get_diff,
            ai_edit_create_snapshot,
            ai_edit_restore_snapshot,
            ai_edit_undo_operation,
            ai_edit_revert_file,
            ai_edit_revert_hunk,
            ai_edit_revert_task,
            ai_edit_set_pin
        ]);
    emit_startup_step("tauri.builder.ready", app_started_at, builder_started_at);

    emit_startup_event("tauri.run.start", app_started_at);
    if let Err(error) = app.run(tauri::generate_context!()) {
        eprintln!("failed to run SH editor: {error}");
        std::process::exit(1);
    }
}