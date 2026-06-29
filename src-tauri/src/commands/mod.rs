pub(crate) mod builtin_agent;
pub(crate) mod agent_webview;
pub(crate) mod ai;
pub(crate) mod contracts;
pub(crate) mod error;
pub(crate) mod format;
pub(crate) mod git;
pub(crate) mod lsp;
pub(crate) mod path_util;
pub(crate) mod script_run;
pub(crate) mod search;
pub(crate) mod shell_tools;
pub(crate) mod skills;
pub(crate) mod ssh;
pub(crate) mod ssh_pool;
pub(crate) mod terminal;
pub(crate) mod window;
pub(crate) mod window_stage;
pub(crate) mod workspace_fs;
pub(crate) mod workspace_watcher;

#[cfg(windows)]
const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

pub use contracts::{
    DocumentEncoding, ExecutionEnvironment,
    ExecutionOption, ExecutorKind, FormatDocumentPayload, FormatDocumentRequest,
    FormatScriptPayload, FormatScriptRequest, ImageAssetPayload, SaveScriptRequest,
    ScriptFilePayload, SshConfigHostPayload, SshConnectionTestPayload, SshConnectionTestRequest,
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
pub use error::CommandError;
pub use lsp::LspManager;
pub(crate) use lsp::commands::lsp_stop;
pub(crate) use script_run::{count_to_u32, find_command_path, line_count};
pub(crate) use ssh_pool::shutdown_ssh_pool;
pub use terminal::{
    TerminalSessionState, shutdown_all_terminal_sessions, spawn_orphan_terminal_session_reaper,
};
pub(crate) use workspace_fs::{decode_script_bytes, encode_script_content, resolve_workspace_root};
pub use workspace_watcher::WorkspaceWatcher;

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
