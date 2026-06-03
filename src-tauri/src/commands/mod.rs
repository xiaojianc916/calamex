mod agent_sidecar;
mod ai;
pub(crate) mod contracts;
pub(crate) mod git;
pub(crate) mod script_run;
pub(crate) mod search;
pub(crate) mod shell_tools;
mod ssh;
pub(crate) mod ssh_pool;
pub(crate) mod terminal;
pub(crate) mod window;
pub(crate) mod window_stage;
pub(crate) mod workspace_fs;
pub(crate) mod workspace_watcher;
mod lsp;

#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

pub use agent_sidecar::{
    agent_sidecar_chat, agent_sidecar_execute, agent_sidecar_health, agent_sidecar_plan,
    agent_sidecar_plan_approve, agent_sidecar_plan_finish, agent_sidecar_plan_query,
    agent_sidecar_plan_reject, agent_sidecar_plan_replan, agent_sidecar_plan_validate,
    agent_sidecar_resolve_approval, agent_sidecar_restart, agent_sidecar_restore_checkpoint,
    agent_sidecar_warmup,
};
pub use ai::{
    ai_agent_classify_task, ai_agent_set_network_permission, ai_apply_patch, ai_cancel,
    ai_chat_stream, ai_clear_credentials, ai_connect_provider,
    ai_edit_create_snapshot, ai_edit_get_auth_level, ai_edit_get_diff, ai_edit_list_timeline,
    ai_edit_restore_snapshot, ai_edit_revert_file, ai_edit_revert_hunk, ai_edit_revert_task,
    ai_edit_set_auth_level, ai_edit_set_pin, ai_edit_undo_operation,
    ai_generate_conversation_title, ai_generate_suggestion_pool, ai_get_config,
    ai_get_suggestion_pool_cache, ai_inline_complete, ai_propose_patch, ai_save_config,
    ai_save_credentials, ai_test_provider, ai_test_provider_config, ai_web_fetch, ai_web_search,
};
pub use contracts::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, DocumentEncoding, ExecutionEnvironment,
    ExecutionOption, ExecutorKind, FormatScriptPayload, FormatScriptRequest, ImageAssetPayload,
    SaveScriptRequest, ScriptFilePayload,
    SshConfigHostPayload, SshConnectionTestPayload, SshConnectionTestRequest,
    SshDirectoryCreatePayload, SshDirectoryCreateRequest, SshDirectoryEntryPayload,
    SshDirectoryListPayload, SshDirectoryListRequest, SshFileDownloadPayload,
    SshFileDownloadRequest, SshFileReadPayload, SshFileReadRequest, SshFileUploadPayload,
    SshFileUploadRequest, SshFileWritePayload, SshFileWriteRequest, SshPasswordGetRequest,
    SshPasswordPayload, SshPasswordSaveRequest, SshPasswordStatusPayload, SshPathDeletePayload,
    SshPathDeleteRequest, SshPathRenamePayload, SshPathRenameRequest, WorkspaceDirectoryPayload,
    WorkspaceEntry, WorkspacePathCreatePayload, WorkspacePathCreateRequest,
    WorkspacePathDeletePayload, WorkspacePathDeleteRequest, WorkspacePathKind,
    WorkspacePathRenamePayload, WorkspacePathRenameRequest,
};
pub use git::{
    apply_git_stash, checkout_git_branch, commit_git_index, create_git_branch, discard_git_paths,
    drop_git_stash, get_git_diff_preview, get_git_file_baseline, get_git_pull_request_support,
    get_git_repository_status, init_git_repository, list_git_branches, list_git_commit_history,
    list_git_stashes, save_git_stash, stage_git_paths, unstage_git_paths,
};
pub use script_run::detect_execution_environment;
pub(crate) use script_run::{find_command_path, line_count};
pub use search::{apply_workspace_replacement, preview_workspace_replacement, search_workspace};
pub use shell_tools::{analyze_script, format_script};
pub use ssh::{
    create_ssh_directory, delete_ssh_path, download_ssh_file, get_ssh_password,
    list_ssh_config_hosts, list_ssh_directory, read_ssh_file, rename_ssh_path, save_ssh_password,
    test_ssh_connection, trust_ssh_host_key, upload_ssh_file, write_ssh_file,
};
pub use terminal::{
    cancel_terminal_run, close_terminal_session, dispatch_script_to_terminal,
    ensure_terminal_session, resize_terminal_session, shutdown_all_terminal_sessions,
    write_terminal_input, TerminalSessionState,
};
pub use window::set_window_background;
pub use window_stage::apply_window_stage;
pub use workspace_fs::{
    create_workspace_path, delete_workspace_path, list_workspace_entries, load_image_asset,
    load_script, rename_workspace_path, save_script,
};
pub(crate) use workspace_fs::{
    decode_script_bytes, encode_script_content, resolve_workspace_root,
};
pub use workspace_watcher::{
    start_workspace_watching, stop_workspace_watching, WorkspaceWatcher,
};
pub use lsp::{
    lsp_start, lsp_stop, lsp_did_open, lsp_did_change, lsp_did_close,
    lsp_completion, lsp_hover, LspManager,
};

#[cfg(windows)]
pub(crate) fn configure_std_command_for_background(
    command: &mut std::process::Command,
) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;

    command.creation_flags(CREATE_NO_WINDOW_FLAG)
}

#[cfg(not(windows))]
pub(crate) fn configure_std_command_for_background(
    command: &mut std::process::Command,
) -> &mut std::process::Command {
    command
}

#[cfg(windows)]
pub(crate) fn configure_tokio_command_for_background(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    command.creation_flags(CREATE_NO_WINDOW_FLAG)
}

#[cfg(not(windows))]
pub(crate) fn configure_tokio_command_for_background(
    command: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    command
}
