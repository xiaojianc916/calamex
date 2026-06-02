use crate::commands::{
    cancel_terminal_run, close_terminal_session, dispatch_script_to_terminal,
    ensure_terminal_session, resize_terminal_session, script_run, search, shell_tools, window,
    window_stage, workspace_fs, workspace_watcher, write_terminal_input,
};
use specta_typescript::Typescript;
use std::path::PathBuf;
use tauri_specta::{collect_commands, collect_events, Builder, ErrorHandlingMode};

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .error_handling(ErrorHandlingMode::Throw)
        // ↓↓↓ events 先 ↓↓↓
        .events(collect_events![
            workspace_watcher::WorkspaceFsEvent,
        ])
        // ↓↓↓ commands 后（它会"封口"返回 Commands，不能再 .events()）↓↓↓
        .commands(collect_commands![
            script_run::detect_execution_environment,
            search::apply_workspace_replacement,
            search::preview_workspace_replacement,
            search::search_workspace,
            shell_tools::analyze_script,
            shell_tools::format_script,
            window_stage::apply_window_stage,
            window::set_window_background,
            workspace_fs::create_workspace_path,
            workspace_fs::delete_workspace_path,
            workspace_fs::list_workspace_entries,
            workspace_fs::load_image_asset,
            workspace_fs::load_script,
            workspace_fs::rename_workspace_path,
            workspace_fs::save_script,
            workspace_watcher::start_workspace_watching,
            workspace_watcher::stop_workspace_watching,
            // ↓↓↓ terminal：从手写 Zod 契约迁入 specta 生成轨 ↓↓↓
            ensure_terminal_session,
            write_terminal_input,
            resize_terminal_session,
            close_terminal_session,
            dispatch_script_to_terminal,
            cancel_terminal_run,
        ])
}

pub fn export(builder: &Builder<tauri::Wry>) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/bindings/tauri.ts");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("failed to create tauri binding directory");
    }
    builder
        .export(Typescript::default(), path)
        .expect("failed to export tauri-specta TypeScript bindings");
}
