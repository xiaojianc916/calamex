/**
 * ACP 协议工具调用 VM(`IAiThreadToolCall`)→ 现有平铺时间线渲染 VM
 * (`IAiThreadToolCallEntry`)的纯适配层。
 *
 * 设计动机(ADR-20260617 Block 4 / slice 4a):`AiThreadToolCall.vue` 已能按
 * `raw | text | terminal | diff` 分派渲染,但它消费的是旧渲染 VM。ACP 工具调用经
 * `from-acp-tool-call` / `from-acp-events` 已归一到协议 VM;本层把协议 VM 适配到
 * 渲染 VM,使 Kimi 等 openWorld 后端的工具调用「零改渲染层」即可复用现成 UI。
 * 两套 VM 的彻底合一在 Block 5 退役旧 VM 时完成;在此之前本适配器是唯一桥接点
 * (单一数据源,不另造解析)。
 *
 * 纯函数:无副作用、不读时钟、对同一入参恒定输出,便于单测与结构化复用。
 *
 * 已知边界(slice 4a):现有 `.vue` 的 diff 行体经 `patches` prop 按路径查 hunk,
 * 因此本层产出的 ACP diff 仅渲染「路径 + 增删计数」头部,行体在 slice 4c 改
 * `.vue` 直接消费协议 hunk 时补齐。
 */
import type { TTaskIcon } from '@/components/business/ai/plan/runtime-timeline';
import type {
  IAiAgentChangedFile,
  IAiDiffHunkPreview,
  TAiAgentChangedFileStatus,
} from '@/types/ai/patch';
import type {
  IAiThreadContentBlock,
  IAiThreadToolCall,
  IAiThreadToolCallContent,
  TAiThreadToolCallStatus,
  TAiThreadToolKind,
} from '@/types/ai/thread';

import type {
  IAiThreadToolCallEntry,
  TAiThreadToolContent,
  TAiThreadToolStatus,
} from './entry-types';

/**
 * ACP 工具种类 → 渲染图标。仅使用 `TTaskIcon` 的显式字面量(非 `TAiRuntimeToolKind`
 * 成员),保证类型安全;`TASK_ICON_MAP` 缺键时 `.vue` 会回退到 system 图标,渲染不炸。
 * 用 `Record` 强制穷尽:`AI_TOOL_KINDS` 新增成员会触发 typecheck 报错。
 */
const TOOL_KIND_ICON: Record<TAiThreadToolKind, TTaskIcon> = {
  read: 'file',
  edit: 'patch',
  delete: 'file',
  move: 'files',
  search: 'catalog',
  execute: 'play',
  think: 'brain',
  fetch: 'globe',
  switch_mode: 'plug',
  other: 'note',
};

/** ACP 工具状态 → 渲染 VM 状态(穷尽映射)。ACP 无 awaiting-confirmation / denied。 */
const TOOL_STATUS: Record<TAiThreadToolCallStatus, TAiThreadToolStatus> = {
  pending: 'pending',
  in_progress: 'running',
  completed: 'succeeded',
  failed: 'failed',
  canceled: 'canceled',
};

/** 标题缺省时按工具种类兜底,避免渲染出空白工具行(穷尽映射)。 */
const TOOL_KIND_FALLBACK_LABEL: Record<TAiThreadToolKind, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Search',
  execute: 'Run',
  think: 'Thinking',
  fetch: 'Fetch',
  switch_mode: 'Switch mode',
  other: 'Tool',
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected ACP tool-call variant: ${JSON.stringify(value)}`);
};

/** pending / in_progress 视为「仍在进行」,据此决定终端占位是否显示流式态。 */
const isLiveStatus = (status: TAiThreadToolCallStatus): boolean =>
  status === 'pending' || status === 'in_progress';

/** 内容块 → markdown:图片渲染为 markdown 图片,资源链接 / 来源渲染为链接。 */
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
    default:
      return assertNever(block);
  }
};

/** 按 hunk 行类型统计增删行数(行体渲染在 4c,这里仅用于头部计数)。 */
const countDiffLines = (
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

/** 全部 hunk 都以 `@@ -0,0` 起始 ⇒ 新建文件;否则按修改处理(删除态由上游另行表达)。 */
const resolveChangedFileStatus = (
  hunks: readonly IAiDiffHunkPreview[],
): TAiAgentChangedFileStatus =>
  hunks.length > 0 && hunks.every((hunk) => hunk.header.startsWith('@@ -0,0'))
    ? 'added'
    : 'modified';

const mapContentItem = (
  toolCallId: string,
  index: number,
  item: IAiThreadToolCallContent,
  live: boolean,
): TAiThreadToolContent => {
  const id = `${toolCallId}:c${index}`;

  switch (item.type) {
    case 'content':
      return { type: 'text', id, markdown: contentBlockToMarkdown(item.block) };
    case 'diff': {
      const { additions, deletions } = countDiffLines(item.diff.hunks);
      const file: IAiAgentChangedFile = {
        path: item.diff.filePath,
        status: resolveChangedFileStatus(item.diff.hunks),
        additions,
        deletions,
        diffRef: item.diff.diffRef,
      };

      return { type: 'diff', id, file, patchSummaryId: item.diff.diffRef };
    }
    case 'terminal':
      // ACP 终端以 id 引用,真实输出经 `terminal/*` 实时下发(D7);此处先占位。
      return { type: 'terminal', id, title: 'Terminal', output: '', streaming: live };
    default:
      return assertNever(item);
  }
};

/** 单条 ACP 协议工具调用 → 渲染 VM 工具调用条目。 */
export const mapAcpToolCallToThreadEntry = (
  messageId: string,
  toolCall: IAiThreadToolCall,
): IAiThreadToolCallEntry => {
  const live = isLiveStatus(toolCall.status);
  const title =
    toolCall.title.trim().length > 0 ? toolCall.title : TOOL_KIND_FALLBACK_LABEL[toolCall.kind];

  return {
    kind: 'tool-call',
    id: `${messageId}:acp:${toolCall.id}`,
    messageId,
    icon: TOOL_KIND_ICON[toolCall.kind],
    title,
    tags: [],
    status: TOOL_STATUS[toolCall.status],
    content: toolCall.content.map((item, index) =>
      mapContentItem(toolCall.id, index, item, live),
    ),
  };
};

/** 一组 ACP 协议工具调用 → 渲染 VM 工具调用条目(保持入参顺序)。 */
export const buildAcpThreadToolEntries = (
  messageId: string,
  toolCalls: readonly IAiThreadToolCall[],
): IAiThreadToolCallEntry[] =>
  toolCalls.map((toolCall) => mapAcpToolCallToThreadEntry(messageId, toolCall));
