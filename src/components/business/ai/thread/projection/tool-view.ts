/**
 * 工具调用「渲染视图」投影(ADR-20260617 B 方案)。
 *
 * 协议 VM(`IAiThreadToolCall`,对标 Zed `ToolCall`)保持纯净;渲染所需的派生
 * 信息(图标 / 展示态 / 终端输出 / diff 行数 / 受影响文件)全部由本纯函数从协议
 * VM + 终端注册表 + 审批队列**派生**,不回灌污染协议契约,也不引入并行真源。
 *
 * 设计要点(对齐 Zed,不自创启发式):
 * - 图标由 `kind` 决定(Zed `ToolKind` → 图标),不再按 toolName 正则猜测;
 * - 标题为单段 `title`(Zed `label`),不再做「动词 + 参数」启发式拆分;
 * - 展示态在协议 5 态之上,由审批队列派生 `awaiting-confirmation`(Zed 等待
 *   权限时工具停在 pending,审批是独立流);`denied` 由协议落到 failed /
 *   canceled,本投影不臆造;
 * - locations 为工具触及文件(Zed follow-along),按 path+line 去重后透传,供
 *   组件渲染受影响文件 chips;
 * - 终端内容仅持 `terminalId`,输出经注册表按 id 查得(对接 D7 终端流式)。
 */
import type { TTaskIcon } from '@/components/business/ai/plan/runtime-timeline';
import type { IAiDiffHunkPreview } from '@/types/ai/patch';
import type {
  IAiThreadContentBlock,
  IAiThreadToolCall,
  IAiThreadToolCallContent,
  IAiThreadToolCallLocation,
  TAiThreadToolCallStatus,
  TAiThreadToolKind,
} from '@/types/ai/thread';

/**
 * 工具调用展示态。与 `ThreadToolStatusIcon` 的取值一致;此处为该枚举的单一真源,
 * 后续迁移步骤令该组件反向引用本类型,消除并存定义。
 */
export type TAiThreadToolViewStatus =
  | 'pending'
  | 'running'
  | 'awaiting-confirmation'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'canceled';

export interface IAiThreadToolViewRawContent {
  type: 'raw';
  id: string;
  title: 'Raw Input' | 'Output';
  code: string;
}

export interface IAiThreadToolViewTextContent {
  type: 'text';
  id: string;
  markdown: string;
}

export interface IAiThreadToolViewDiffContent {
  type: 'diff';
  id: string;
  filePath: string;
  additions: number;
  deletions: number;
  hunks: IAiDiffHunkPreview[];
}

export interface IAiThreadToolViewTerminalContent {
  type: 'terminal';
  id: string;
  title: string;
  output: string;
  streaming: boolean;
}

export type TAiThreadToolViewContent =
  | IAiThreadToolViewRawContent
  | IAiThreadToolViewTextContent
  | IAiThreadToolViewDiffContent
  | IAiThreadToolViewTerminalContent;

/** 工具调用渲染视图:`AiThreadToolCall.vue` 的唯一输入模型。 */
export interface IAiThreadToolView {
  id: string;
  icon: TTaskIcon;
  title: string;
  status: TAiThreadToolViewStatus;
  content: TAiThreadToolViewContent[];
  /** 受影响文件(已按 path+line 去重);无则空数组。 */
  locations: IAiThreadToolCallLocation[];
}

/** 终端快照:由终端注册表按 `terminalId` 提供(对接 D7 `terminal/*` 流式)。 */
export interface IAiThreadTerminalSnapshot {
  title?: string;
  output: string;
  streaming: boolean;
}

/**
 * 投影依赖:终端查询 + 审批态查询。两者皆可选,缺省时退化为「无终端输出」/
 * 「无等待态」,使纯函数可独立单测,与驱动循环 / `.vue` 解耦。
 */
export interface IAiThreadToolViewDeps {
  resolveTerminal?: (terminalId: string) => IAiThreadTerminalSnapshot | undefined;
  isAwaitingApproval?: (toolCallId: string) => boolean;
}

/** Zed `ToolKind` → 图标。未知种类经协议 `.catch('other')` 兑底,落到 `system`。 */
const TOOL_KIND_ICON: Record<TAiThreadToolKind, TTaskIcon> = {
  read: 'read',
  edit: 'patch',
  delete: 'write',
  move: 'write',
  search: 'search',
  execute: 'terminal',
  think: 'thinking',
  fetch: 'globe',
  switch_mode: 'task',
  other: 'system',
};

/** 协议状态 → 展示态基线(`awaiting-confirmation` 由审批态另行派生覆盖)。 */
const TOOL_STATUS: Record<TAiThreadToolCallStatus, TAiThreadToolViewStatus> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

const stringifyRaw = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const summarizeHunks = (
  hunks: readonly IAiDiffHunkPreview[],
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        additions += 1;
      } else if (line.kind === 'delete') {
        deletions += 1;
      }
    }
  }
  return { additions, deletions };
};

const contentBlockToMarkdown = (block: IAiThreadContentBlock): string => {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `![${block.alt ?? ''}](${block.src})`;
    case 'resource_link':
      return `[${block.title ?? block.uri}](${block.uri})`;
    case 'source':
      return `[${block.title ?? block.url}](${block.url})`;
  }
};

const projectContentItem = (
  item: IAiThreadToolCallContent,
  id: string,
  deps: IAiThreadToolViewDeps,
): TAiThreadToolViewContent => {
  if (item.type === 'diff') {
    const { additions, deletions } = summarizeHunks(item.diff.hunks);
    return {
      type: 'diff',
      id,
      filePath: item.diff.filePath,
      additions,
      deletions,
      hunks: item.diff.hunks,
    };
  }

  if (item.type === 'terminal') {
    const snapshot = deps.resolveTerminal?.(item.terminalId);
    return {
      type: 'terminal',
      id,
      title: snapshot?.title ?? 'Terminal',
      output: snapshot?.output ?? '',
      streaming: snapshot?.streaming ?? false,
    };
  }

  return {
    type: 'text',
    id,
    markdown: contentBlockToMarkdown(item.block),
  };
};

const toViewContent = (
  toolCall: IAiThreadToolCall,
  deps: IAiThreadToolViewDeps,
): TAiThreadToolViewContent[] => {
  const content: TAiThreadToolViewContent[] = [];

  if (toolCall.rawInput !== undefined) {
    content.push({
      type: 'raw',
      id: `${toolCall.id}:raw-input`,
      title: 'Raw Input',
      code: stringifyRaw(toolCall.rawInput),
    });
  }

  toolCall.content.forEach((item, index) => {
    content.push(projectContentItem(item, `${toolCall.id}:c${index}`, deps));
  });

  if (toolCall.rawOutput !== undefined) {
    content.push({
      type: 'raw',
      id: `${toolCall.id}:raw-output`,
      title: 'Output',
      code: stringifyRaw(toolCall.rawOutput),
    });
  }

  return content;
};

/** 受影响文件:按 path+line 去重(保序),缺省为空数组。 */
const toViewLocations = (toolCall: IAiThreadToolCall): IAiThreadToolCallLocation[] => {
  const locations = toolCall.locations;
  if (locations === undefined || locations.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const result: IAiThreadToolCallLocation[] = [];
  for (const loc of locations) {
    const key = JSON.stringify([loc.path, loc.line ?? null]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(loc.line === undefined ? { path: loc.path } : { path: loc.path, line: loc.line });
  }
  return result;
};

const toViewStatus = (
  toolCall: IAiThreadToolCall,
  deps: IAiThreadToolViewDeps,
): TAiThreadToolViewStatus => {
  const base = TOOL_STATUS[toolCall.status];
  if ((base === 'pending' || base === 'running') && deps.isAwaitingApproval?.(toolCall.id)) {
    return 'awaiting-confirmation';
  }
  return base;
};

/**
 * 将协议工具调用投影为渲染视图。纯函数:相同入参恒得等价结果,无副作用,
 * 可在 reconcile / 组件外独立单测。
 */
export const toAiThreadToolView = (
  toolCall: IAiThreadToolCall,
  deps: IAiThreadToolViewDeps = {},
): IAiThreadToolView => ({
  id: toolCall.id,
  icon: TOOL_KIND_ICON[toolCall.kind],
  title: toolCall.title,
  status: toViewStatus(toolCall, deps),
  content: toViewContent(toolCall, deps),
  locations: toViewLocations(toolCall),
});
