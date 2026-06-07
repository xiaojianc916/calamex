import { z } from 'zod';
import { WORKBENCH_TAB_LIMITS } from '@/constants/workbench';
import { WORKBENCH_SIDEBAR_VIEWS } from '@/types/app';

/** 编辑器视图态是黑盒结构，这里仅做 JSON object 守卫。 */
export const EditorViewStateSchema = z.record(z.string(), z.unknown());
export const SessionTabKindSchema = z.enum(['text', 'image']);
export const SessionWorkbenchSidebarViewSchema = z.enum(WORKBENCH_SIDEBAR_VIEWS);

export const TabStateSchema = z.object({
  path: z.string().min(1),
  pinned: z.boolean().default(false),
  order: z.number().int().nonnegative(),
  kind: SessionTabKindSchema.optional(),
});

export const EditorViewStateEntrySchema = z.object({
  path: z.string().min(1),
  viewState: EditorViewStateSchema,
  updatedAt: z.string().datetime(),
});

/**
 * 未保存草稿：在编辑器中有改动但尚未保存到磁盘时，按文件路径缓存的草稿内容。
 * 用于崩溃 / 意外重载后恢复未保存的修改。
 * - content：当前未保存的内容。
 * - baselineContent：草稿创建时磁盘上的内容（保存基线）。恢复时若磁盘内容已与
 *   该基线不一致（被外部改动），则丢弃草稿，避免覆盖外部修改。
 */
export const DocumentDraftSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  baselineContent: z.string(),
  updatedAt: z.string().datetime(),
});

export const SessionWorkbenchStateSchema = z
  .object({
    activeSidebarView: SessionWorkbenchSidebarViewSchema.default('explorer'),
    explorerExpandedPaths: z.array(z.string().min(1)).max(120).default([]),
    explorerSelectedPath: z.string().nullable().default(null),
    isTerminalVisible: z.boolean().default(true),
  })
  .default({
    activeSidebarView: 'explorer',
    explorerExpandedPaths: [],
    explorerSelectedPath: null,
    isTerminalVisible: true,
  });

export const SessionSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceRoot: z.string().nullable(),
  // 这里只保存标签页元数据，不保存正文内容；正文缓冲区由运行时按需加载/淘汰。
  openTabs: z.array(TabStateSchema).max(WORKBENCH_TAB_LIMITS.maxPersistedOpenTabs),
  activeTabPath: z.string().nullable(),
  viewStates: z.array(EditorViewStateEntrySchema).max(WORKBENCH_TAB_LIMITS.maxViewStateEntries),
  workbench: SessionWorkbenchStateSchema,
  recentWorkspaces: z.array(z.string()).max(10),
  recentFiles: z.array(z.string()).max(50),
  // 可选 + 默认空数组：旧快照（无 drafts 字段）仍可解析，无需 schemaVersion 迁移。
  drafts: z.array(DocumentDraftSchema).max(WORKBENCH_TAB_LIMITS.maxDraftEntries).default([]),
  savedAt: z.string().datetime(),
});

export type TSessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export type TTabState = z.infer<typeof TabStateSchema>;
export type TSessionTabKind = z.infer<typeof SessionTabKindSchema>;
export type TSessionWorkbenchState = z.infer<typeof SessionWorkbenchStateSchema>;
export type TDocumentDraft = z.infer<typeof DocumentDraftSchema>;
