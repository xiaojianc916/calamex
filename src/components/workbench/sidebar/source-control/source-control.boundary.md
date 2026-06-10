# Source control extraction boundary

`source-control/` owns Git sidebar UI.

## Owns

- Source control panel tabs
- Git change list and commit actions
- Git history graph and hover card
- Branch, pull request, and stash tab presentation
- GitHub auth pill UI

## Depends on

- `src/store/git` for Git operations and derived state
- `src/store/editor` only for opening Git diff documents
- `src/services/github-author` for commit author enrichment

## Does not own

- Workspace filesystem watching
- Editor content lifecycle
- Terminal/session state

## Target split

`GitHistoryGraph.vue` should be split into:

- `GitHistoryGraphRow.vue`
- `GitHistoryGraphHoverCard.vue`
- `GitHistoryGraphContextMenu.vue`
- `GitCommitFileList.vue`
- `useGitHistoryGraph.ts`
- `useGitHistoryHoverCard.ts`
