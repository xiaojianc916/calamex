# Run extraction boundary

`run/` owns run templates, active run state presentation, and run history sidebar UI.

## Owns

- Run sidebar shell
- Command template catalog presentation
- Active run summary
- Run history list
- Template insertion events

## Depends on

- Parent workbench state for active document/run summaries
- Static `templateCatalog.ts` for built-in templates

## Does not own

- Integrated terminal process/session implementation
- Script execution IPC
- Editor document mutation

## Target split

`RunSidebarTemplatesSection.vue` should be split into:

- `RunTemplateCategory.vue`
- `RunTemplateCard.vue`
- `RunTemplateSearch.vue` if search/filtering expands
