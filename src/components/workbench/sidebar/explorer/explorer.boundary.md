# Explorer extraction boundary

`explorer/` owns the workspace file tree sidebar.

## Owns

- Workspace root loading and refresh
- Directory expansion/collapse state
- Inline create and inline rename UI state
- File/folder mutation orchestration
- Workspace file watcher subscription
- Explorer context menu state

## Depends on

- `src/services/tauri` for filesystem I/O
- `src/store/git` only for refreshing Git status after filesystem events
- `src/utils/path` and `src/utils/workspace` for path normalization

## Does not own

- Editor document opening semantics
- Git diff document state
- Shell/workbench layout state

## Target public component

`WorkspaceExplorerPanel.vue` should expose only these events:

- `open-file`
- `open-folder`
- `open-git-diff` when applicable
- `explorer-state-change`
