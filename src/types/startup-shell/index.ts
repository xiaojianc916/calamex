import { z } from 'zod';
import { WORKBENCH_SIDEBAR_VIEWS } from '@/types/app';

export const StartupShellTabKindSchema = z.enum(['text', 'image']);
export const StartupShellSidebarViewSchema = z.enum(WORKBENCH_SIDEBAR_VIEWS);

export const StartupShellTabSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  title: z.string().min(1),
  kind: StartupShellTabKindSchema,
  order: z.int().nonnegative(),
  isActive: z.boolean(),
});

export const StartupShellStateSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceRoot: z.string().nullable(),
  workspaceName: z.string().nullable(),
  activeSidebarView: StartupShellSidebarViewSchema,
  explorerExpandedPaths: z.array(z.string().min(1)).max(120),
  explorerSelectedPath: z.string().nullable(),
  isTerminalVisible: z.boolean(),
  openTabs: z.array(StartupShellTabSchema).max(30),
  activeTabPath: z.string().nullable(),
});

export type TStartupShellState = z.infer<typeof StartupShellStateSchema>;
export type TStartupShellTab = z.infer<typeof StartupShellTabSchema>;
