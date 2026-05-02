mod agent_sidecar;
mod ai;
pub(crate) mod contracts;
mod git;
mod script_run;
mod search;
mod shell_tools;
mod ssh;
mod terminal;
mod window;
mod window_stage;
mod workspace_fs;

#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

pub use agent_sidecar::{
    agent_sidecar_chat, agent_sidecar_execute, agent_sidecar_health, agent_sidecar_plan,
    agent_sidecar_resolve_approval,
};
pub use ai::{
    ai_agent_approve_plan, ai_agent_cancel, ai_agent_classify_task, ai_agent_get_run,
    ai_agent_list_runs, ai_agent_pause, ai_agent_resolve_tool_confirmation, ai_agent_resume,
    ai_agent_run_plan, ai_agent_run_step, ai_agent_set_network_permission, ai_apply_patch,
    ai_build_index, ai_cancel, ai_chat, ai_chat_stream, ai_clear_credentials, ai_code_action,
    ai_connect_provider, ai_edit_create_snapshot, ai_edit_get_auth_level, ai_edit_get_diff,
    ai_edit_list_timeline, ai_edit_restore_snapshot, ai_edit_revert_file, ai_edit_revert_hunk,
    ai_edit_revert_task, ai_edit_set_auth_level, ai_edit_undo_operation,
    ai_generate_conversation_title, ai_get_config, ai_get_provider_profile_detail,
    ai_inline_complete, ai_list_provider_profiles, ai_list_tools, ai_plan_task, ai_propose_patch,
    ai_query_index, ai_save_config, ai_save_credentials, ai_switch_provider_profile,
    ai_test_provider, ai_test_provider_config, ai_web_fetch, ai_web_search,
};
pub use contracts::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, ExecutionEnvironment, ExecutionOption,
    FormatScriptPayload, FormatScriptRequest, ImageAssetPayload, SaveScriptRequest,
    ScriptDiagnosticPayload, ScriptFilePayload, SshConfigHostPayload, SshConnectionTestPayload,
    SshConnectionTestRequest, SshDirectoryCreatePayload, SshDirectoryCreateRequest,
    SshDirectoryEntryPayload, SshDirectoryListPayload, SshDirectoryListRequest,
    SshFileDownloadPayload, SshFileDownloadRequest, SshFileUploadPayload, SshFileUploadRequest,
    SshPathDeletePayload, SshPathDeleteRequest, SshPathRenamePayload, SshPathRenameRequest,
    WorkspaceDirectoryPayload, WorkspaceEntry, WorkspacePathCreatePayload,
    WorkspacePathCreateRequest, WorkspacePathDeletePayload, WorkspacePathDeleteRequest,
    WorkspacePathRenamePayload, WorkspacePathRenameRequest,
};
pub use git::{
    commit_git_index, discard_git_paths, get_git_diff_preview, get_git_file_baseline,
    get_git_repository_status, init_git_repository, stage_git_paths, unstage_git_paths,
};
pub use script_run::detect_execution_environment;
pub(crate) use script_run::{create_temp_script, find_command_path, line_count};
pub use search::search_workspace;
pub use shell_tools::{analyze_script, format_script};
pub use ssh::{
    create_ssh_directory, delete_ssh_path, download_ssh_file, list_ssh_config_hosts,
    list_ssh_directory, rename_ssh_path, test_ssh_connection, upload_ssh_file,
};
pub(crate) use terminal::{build_temp_file_suffix, to_wsl_path};
pub use terminal::{
    cancel_terminal_run, close_terminal_session, dispatch_script_to_terminal,
    ensure_terminal_session, resize_terminal_session, shutdown_all_terminal_sessions,
    write_terminal_input, TerminalSessionState,
};
pub use window::set_window_background;
pub use window_stage::{apply_window_stage, begin_startup_transition, finalize_startup_transition};
pub use workspace_fs::{
    create_workspace_path, delete_workspace_path, list_workspace_entries, load_image_asset,
    load_script, rename_workspace_path, save_script,
};
pub(crate) use workspace_fs::{
    decode_script_bytes, encode_script_content, resolve_workspace_root, workspace_name,
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
