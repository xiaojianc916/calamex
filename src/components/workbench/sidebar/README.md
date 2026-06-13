# Workbench sidebar domain

This directory is the target home for the five primary workbench sidebar panels:

- `explorer/` — workspace file explorer
- `search/` — workspace search and replace
- `source-control/` — Git status, history, branches, PRs, and stash
- `run/` — run panel, command templates, and run history
- `ssh/` — SSH/SFTP remote explorer, transfers, and file preview
- `shared/` — sidebar-only shared shell components and utilities

## Design rules

1. `AppSidebar.vue` should stay a thin panel host/router.
2. Each panel owns its local components, composables, types, and tests.
3. Cross-panel code belongs in `shared/` only when at least two panels need it.
4. Service calls still go through `src/services/`; panel components must not create a second I/O layer.
5. Refactors should be incremental: first move by domain, then split large panels by responsibility.
