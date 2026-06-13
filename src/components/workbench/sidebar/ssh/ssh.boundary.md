# SSH extraction boundary

`ssh/` owns SSH/SFTP remote sidebar behavior.

## Owns

- SSH connection form and validation state
- Recent SSH connection selection
- Remote directory loading and breadcrumb state
- Remote file/folder context menu
- Upload/download transfer list
- Remote path create/rename/delete workflows
- Remote file preview dialog orchestration
- Best-effort terminal SSH bridge

## Depends on

- `src/store/ssh` for persisted SSH sidebar state
- `src/services/tauri` for SSH/SFTP I/O
- `useIntegratedTerminalControls` for sending SSH commands into the terminal

## Does not own

- Terminal session registry internals
- Local workspace explorer state
- Editor document state

## Target split

`SshSidebarPanel.vue` should become a coordinator around:

- `SshConnectForm.vue`
- `SshRecentConnections.vue`
- `SshRemoteExplorer.vue`
- `SshTransferList.vue`
- `SshPathDialogs.vue`
- `preview/SshFilePreviewDialog.vue`
