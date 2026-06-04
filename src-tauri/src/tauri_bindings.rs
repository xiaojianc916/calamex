use crate::commands::lsp::commands as lsp_commands;
use crate::commands::terminal::commands as terminal_commands;
use crate::commands::{
    agent_sidecar, ai, git, script_run, search, shell_tools, ssh, window, window_stage,
    workspace_fs, workspace_watcher,
};
use specta_typescript::Typescript;
use std::path::PathBuf;
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands, collect_events};

pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .error_handling(ErrorHandlingMode::Throw)
        // ↓↓↓ events 先 ↓↓↓
        .events(collect_events![workspace_watcher::WorkspaceFsEvent,])
        // ↓↓↓ commands 后（它会\"封口\"返回 Commands，不能再 .events()）↓↓↓
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
            // ↓↓↓ terminal：从手写 Zod 契约迁入 specta 生成轨（用模块限定路径以解析配套宏）↓↓↓
            terminal_commands::ensure_terminal_session,
            terminal_commands::write_terminal_input,
            terminal_commands::resize_terminal_session,
            terminal_commands::close_terminal_session,
            terminal_commands::dispatch_script_to_terminal,
            terminal_commands::cancel_terminal_run,
            // ↓↓↓ git：从手写 Zod 契约迁入 specta 生成轨（用模块限定路径以解析配套宏）↓↓↓
            git::branches::list_git_branches,
            git::branches::checkout_git_branch,
            git::branches::create_git_branch,
            git::diff::get_git_diff_preview,
            git::history::list_git_commit_history,
            git::pull_request::get_git_pull_request_support,
            git::stash::list_git_stashes,
            git::stash::save_git_stash,
            git::stash::apply_git_stash,
            git::stash::drop_git_stash,
            git::status::get_git_repository_status,
            git::status::init_git_repository,
            git::status::get_git_file_baseline,
            git::status::stage_git_paths,
            git::status::unstage_git_paths,
            git::status::commit_git_index,
            git::status::discard_git_paths,
            // ↓↓↓ ssh：从手写 Zod 契约迁入 specta 生成轨（用模块限定路径以解析配套宏）↓↓↓
            ssh::connection::test_ssh_connection,
            ssh::connection::trust_ssh_host_key,
            ssh::credentials::save_ssh_password,
            ssh::credentials::get_ssh_password,
            ssh::config::list_ssh_config_hosts,
            ssh::transfer::list_ssh_directory,
            ssh::transfer::download_ssh_file,
            ssh::transfer::upload_ssh_file,
            ssh::transfer::read_ssh_file,
            ssh::transfer::write_ssh_file,
            ssh::transfer::delete_ssh_path,
            ssh::transfer::rename_ssh_path,
            ssh::transfer::create_ssh_directory,
            // ↓↓↓ agent_sidecar：从手写 Zod 契约迁入 specta 生成轨（用模块限定路径以解析配套宏）↓↓↓
            agent_sidecar::agent_sidecar_health,
            agent_sidecar::agent_sidecar_restart,
            agent_sidecar::agent_sidecar_warmup,
            agent_sidecar::agent_sidecar_chat,
            agent_sidecar::agent_sidecar_plan,
            agent_sidecar::agent_sidecar_plan_approve,
            agent_sidecar::agent_sidecar_plan_query,
            agent_sidecar::agent_sidecar_plan_reject,
            agent_sidecar::agent_sidecar_plan_finish,
            agent_sidecar::agent_sidecar_plan_validate,
            agent_sidecar::agent_sidecar_plan_replan,
            agent_sidecar::agent_sidecar_execute,
            agent_sidecar::agent_sidecar_resolve_approval,
            agent_sidecar::agent_sidecar_restore_checkpoint,
            agent_sidecar::agent_sidecar_orchestrate,
            agent_sidecar::agent_sidecar_orchestrate_resume,
            // ↓↓↓ ai gateway / chat / config / inline ↓↓↓
            ai::gateway::ai_get_config,
            ai::gateway::ai_save_config,
            ai::gateway::ai_save_credentials,
            ai::gateway::ai_test_provider_config,
            ai::gateway::ai_connect_provider,
            ai::gateway::ai_clear_credentials,
            ai::gateway::ai_test_provider,
            ai::gateway::ai_generate_conversation_title,
            ai::gateway::ai_get_suggestion_pool_cache,
            ai::gateway::ai_generate_suggestion_pool,
            ai::gateway::ai_chat_stream,
            ai::gateway::ai_cancel,
            ai::gateway::ai_inline_complete,
            // ↓↓↓ ai agent / web tools ↓↓↓
            ai::agent::ai_agent_classify_task,
            ai::agent::ai_agent_set_network_permission,
            ai::tools::ai_web_search,
            ai::tools::ai_web_fetch,
            // ↓↓↓ ai edit（patch / timeline / snapshots）↓↓↓
            ai::edit::ai_propose_patch,
            ai::edit::ai_apply_patch,
            ai::edit::ai_edit_get_auth_level,
            ai::edit::ai_edit_set_auth_level,
            ai::edit::ai_edit_list_timeline,
            ai::edit::ai_edit_set_pin,
            ai::edit::ai_edit_get_diff,
            ai::edit::ai_edit_create_snapshot,
            ai::edit::ai_edit_restore_snapshot,
            ai::edit::ai_edit_undo_operation,
            ai::edit::ai_edit_revert_file,
            ai::edit::ai_edit_revert_hunk,
            ai::edit::ai_edit_revert_task,
            // ↓↓↓ lsp：补登记进 specta 生成轨（命令早已带 #[specta::specta]，此前漏登记）↓↓↓
            lsp_commands::lsp_start,
            lsp_commands::lsp_stop,
            lsp_commands::lsp_did_open,
            lsp_commands::lsp_did_change,
            lsp_commands::lsp_did_close,
            lsp_commands::lsp_completion,
            lsp_commands::lsp_hover,
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
