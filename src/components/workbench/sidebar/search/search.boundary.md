# Search extraction boundary

`search/` owns workspace search and replacement sidebar behavior.

## Owns

- Search query controls
- Path include/exclude filters
- Search request debounce/cancel lifecycle
- Search result grouping and virtualization
- Replacement preview lifecycle
- Single-line and bulk replacement actions

## Depends on

- `src/services/tauri` for search and replacement commands
- `useSidecarChangedDocumentRefresh` to refresh changed documents after replacement
- `search-sidebar-text.ts` for matcher/highlight pure helpers

## Does not own

- Opening editor tabs beyond emitting `open-file`
- Workspace root selection
- Global command palette/search shortcuts outside the panel

## Target public component

`SearchSidebarPanel.vue` should stay a thin coordinator around:

- `SearchQueryControls.vue`
- `SearchResultsList.vue`
- `ReplacementPreviewList.vue`
- `useWorkspaceSearch.ts`
- `useWorkspaceReplacement.ts`
