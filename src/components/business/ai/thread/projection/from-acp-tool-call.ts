/* ============================================================================
 * ACP → protocol-VM 工具调用 ACL（ADR-20260617）
 *
 * 把外部 ACP agent（如 Kimi）经 Rust host 最小透传而来的 `tool_call` /
 * `tool_call_update`（见 `@/types/ai/acp-tool-call`）**归一**到 `src/types/ai/thread`
 * 协议 VM 的 `IAiThreadToolCall`，与 Mastra 源共用同一渲染 VM。
 *
 * 设计（对齐 ADR 四设计点）：
 *  ① 合并键 = ACP `toolCallId`：`reduceAcpToolCall` 以它 upsert，首帧建条目，
 *     后续 update 仅覆盖出现的字段；`content` / `locations` 一旦出现即整体替换
 *     （ACP 语义）。
 *  ② content 判别联合：ACP `ToolCallContent`（content | terminal | diff）→ VM
 *     `{ type: 'content' | 'diff' | 'terminal' }`；ACP `ContentBlock` → VM 富块，
 *     audio / 未知块无对应 VM 形态时安全丢弃（绝不伪造）。
 *  ③ kind 驱动开放目录：以 `AI_TOOL_KINDS` 为单一真源校验，未知种类兑底 `other`，
 *     不阻断渲染。
 *
 * 防腐边界：本层对 ACP wire 采用宽松结构视图读取，不与 `@agentclientprotocol/sdk`
 * 的内部字段可选性强耦合（SDK 升级时随之跟随）；不伪造 Mastra 遥测 base 字段
 * （runId / agentId / timestamp / seq …）。纯函数，不修改入参。
 * ========================================================================== */

import type { TAcpToolCall, TAcpToolCallUpdate } from '@/types/ai/acp-tool-call';
import type {
  IAiThreadContentBlock,
  IAiThreadToolCall,
  IAiThreadToolCallContent,
  IAiThreadToolCallLocation,
  TAiThreadToolCallStatus,
  TAiThreadToolKind,
} from '@/types/ai/thread';
import { AI_TOOL_CALL_STATUSES, AI_TOOL_KINDS } from '@/types/ai/thread';

export type TAcpAnyToolCall = TAcpToolCall | TAcpToolCallUpdate;

/* ---------- 0) 宽松结构视图 + 小工具 -------------------------------------- */

interface IAcpToolCallView {
  toolCallId?: unknown;
  title?: unknown;
  kind?: unknown;
  status?: unknown;
  content?: unknown;
  locations?: unknown;
  rawInput?: unknown;
  rawOutput?: unknown;
}

const asView = (update: TAcpAnyToolCall): IAcpToolCallView => update as unknown as IAcpToolCallView;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/* ---------- 1) kind / status 归一（单一真源校验） ------------------------- */

const ACP_TOOL_KIND_VALUES = new Set<string>(AI_TOOL_KINDS);
const ACP_TOOL_STATUS_VALUES = new Set<string>(AI_TOOL_CALL_STATUSES);

/** ACP `ToolKind` 与 VM `AI_TOOL_KINDS` 同源（VM 额外多出 switch_mode）；
 *  未知种类按协议约定兑底 `other`，不阻断渲染。 */
const mapKind = (kind: unknown): TAiThreadToolKind => {
  const value = typeof kind === 'string' ? kind : '';
  return (ACP_TOOL_KIND_VALUES.has(value) ? value : 'other') as TAiThreadToolKind;
};

/** ACP `ToolCallStatus`(pending|in_progress|completed|failed) ⊂ VM 状态集
 *  （额外含 canceled，由取消路径产生）。非法/缺省返回 undefined（调用方保留旧值）。 */
const mapStatus = (status: unknown): TAiThreadToolCallStatus | undefined => {
  if (typeof status !== 'string') return undefined;
  return ACP_TOOL_STATUS_VALUES.has(status) ? (status as TAiThreadToolCallStatus) : undefined;
};

/* ---------- 2) ContentBlock 归一 ----------------------------------------- */

interface IAcpContentBlockView {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  uri?: unknown;
  name?: unknown;
  title?: unknown;
  resource?: unknown;
}

/** ACP `ContentBlock` → VM `IAiThreadContentBlock`；无对应 VM 形态时返回 null。 */
const mapContentBlock = (block: unknown): IAiThreadContentBlock | null => {
  if (block === null || typeof block !== 'object') return null;
  const view = block as IAcpContentBlockView;

  switch (view.type) {
    case 'text': {
      return { type: 'text', text: typeof view.text === 'string' ? view.text : '' };
    }
    case 'image': {
      const uri = asString(view.uri);
      const data = asString(view.data);
      const mimeType = asString(view.mimeType) ?? 'image/png';
      const src = uri ?? (data ? `data:${mimeType};base64,${data}` : undefined);
      if (src === undefined) return null;
      const alt = asString(view.title) ?? asString(view.name);
      return alt === undefined ? { type: 'image', src } : { type: 'image', src, alt };
    }
    case 'resource_link': {
      const uri = asString(view.uri);
      if (uri === undefined) return null;
      const title = asString(view.title) ?? asString(view.name);
      return title === undefined
        ? { type: 'resource_link', uri }
        : { type: 'resource_link', uri, title };
    }
    case 'resource': {
      // 嵌入式资源：优先取 uri 当链接，其次取内嵌文本当普通文本块。
      const resource =
        view.resource !== null && typeof view.resource === 'object'
          ? (view.resource as { uri?: unknown; text?: unknown })
          : {};
      const uri = asString(resource.uri);
      if (uri !== undefined) {
        const title = asString(view.title) ?? asString(view.name);
        return title === undefined
          ? { type: 'resource_link', uri }
          : { type: 'resource_link', uri, title };
      }
      const text = asString(resource.text);
      return text === undefined ? null : { type: 'text', text };
    }
    default:
      // audio 及未来未知块：无对应 VM 富块，安全丢弃（不伪造）。
      return null;
  }
};

/* ---------- 3) diff：从旧/新文本算行级 hunk ------------------------------- */

const DIFF_CONTEXT_LINES = 3;

const splitLines = (text: unknown): string[] => {
  if (typeof text !== 'string' || text.length === 0) return [];
  return text.split('\n');
};

interface IDiffTextsInput {
  diffRef: string;
  filePath: string;
  oldText: unknown;
  newText: unknown;
}

/**
 * ACP diff 内容块给的是整文件 `oldText` / `newText` 原始文本，而 VM diff 复用
 * `IAiDiffEditorPreview`（行级 hunk）。这里做最小、确定性的「公共前缀/后缀裁剪 +
 * 上下文裁剪（单 hunk）」转换：覆盖单区段编辑的常见场景，多区段最小化留作后续优化。
 */
const buildDiffContent = (input: IDiffTextsInput): IAiThreadToolCallContent => {
  const oldLines = splitLines(input.oldText);
  const newLines = splitLines(input.newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const changedOldEnd = oldLines.length - suffix; // exclusive
  const changedNewEnd = newLines.length - suffix; // exclusive
  const ctxBefore = Math.min(DIFF_CONTEXT_LINES, prefix);
  const ctxAfter = Math.min(DIFF_CONTEXT_LINES, suffix);
  const lineDelta = newLines.length - oldLines.length;

  const lines: Array<{
    id: string;
    kind: 'add' | 'delete' | 'context';
    content: string;
    oldLineNumber?: number;
    newLineNumber?: number;
  }> = [];
  const nextId = (): string => `${input.diffRef}:0:${lines.length}`;

  // 前置上下文（前缀区 old/new 行号一致）。
  for (let i = prefix - ctxBefore; i < prefix; i += 1) {
    lines.push({
      id: nextId(),
      kind: 'context',
      content: oldLines[i],
      oldLineNumber: i + 1,
      newLineNumber: i + 1,
    });
  }
  // 删除（old 变更区）。
  for (let i = prefix; i < changedOldEnd; i += 1) {
    lines.push({ id: nextId(), kind: 'delete', content: oldLines[i], oldLineNumber: i + 1 });
  }
  // 新增（new 变更区）。
  for (let j = prefix; j < changedNewEnd; j += 1) {
    lines.push({ id: nextId(), kind: 'add', content: newLines[j], newLineNumber: j + 1 });
  }
  // 后置上下文（后缀区：old 行号 a+1，new 行号按长度差平移）。
  for (let a = changedOldEnd; a < changedOldEnd + ctxAfter; a += 1) {
    lines.push({
      id: nextId(),
      kind: 'context',
      content: oldLines[a],
      oldLineNumber: a + 1,
      newLineNumber: a + 1 + lineDelta,
    });
  }

  const oldCount = changedOldEnd - prefix + ctxBefore + ctxAfter;
  const newCount = changedNewEnd - prefix + ctxBefore + ctxAfter;
  const oldStart = oldCount === 0 ? 0 : prefix - ctxBefore + 1;
  const newStart = newCount === 0 ? 0 : prefix - ctxBefore + 1;
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;

  return {
    type: 'diff',
    diff: {
      id: input.diffRef,
      title: input.filePath,
      filePath: input.filePath,
      diffRef: input.diffRef,
      hunks: [
        {
          id: `${input.diffRef}:0`,
          filePath: input.filePath,
          diffRef: input.diffRef,
          header,
          lines,
        },
      ],
    },
  };
};

/* ---------- 4) ToolCallContent 归一 -------------------------------------- */

interface IAcpToolCallContentView {
  type?: unknown;
  content?: unknown;
  terminalId?: unknown;
  path?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

const mapContentItem = (item: unknown, toolCallId: string): IAiThreadToolCallContent | null => {
  if (item === null || typeof item !== 'object') return null;
  const view = item as IAcpToolCallContentView;

  switch (view.type) {
    case 'content': {
      const block = mapContentBlock(view.content);
      return block === null ? null : { type: 'content', block };
    }
    case 'terminal': {
      const terminalId = asString(view.terminalId);
      return terminalId === undefined ? null : { type: 'terminal', terminalId };
    }
    case 'diff': {
      const filePath = asString(view.path) ?? '(unknown)';
      const diffRef = `acp-diff:${encodeURIComponent(toolCallId)}:${encodeURIComponent(filePath)}`;
      return buildDiffContent({ diffRef, filePath, oldText: view.oldText, newText: view.newText });
    }
    default:
      return null;
  }
};

const mapContent = (content: unknown, toolCallId: string): IAiThreadToolCallContent[] => {
  if (!Array.isArray(content)) return [];
  const mapped: IAiThreadToolCallContent[] = [];
  for (const item of content) {
    const result = mapContentItem(item, toolCallId);
    if (result !== null) mapped.push(result);
  }
  return mapped;
};

/* ---------- 4.5) ToolCallLocation 归一 ----------------------------------- */

interface IAcpLocationView {
  path?: unknown;
  line?: unknown;
}

/**
 * ACP `locations[]`（`{ path, line? }`）→ VM `IAiThreadToolCallLocation[]`。
 * 非数组返回 undefined（= 本帧未携带，调用方保留旧值）；空数组合法（清空）。
 * 过滤无 path 的项；`line` 仅接受非负整数。
 */
const mapLocations = (locations: unknown): IAiThreadToolCallLocation[] | undefined => {
  if (!Array.isArray(locations)) return undefined;
  const mapped: IAiThreadToolCallLocation[] = [];
  for (const item of locations) {
    if (item === null || typeof item !== 'object') continue;
    const view = item as IAcpLocationView;
    const path = asString(view.path);
    if (path === undefined) continue;
    mapped.push(
      typeof view.line === 'number' && Number.isInteger(view.line) && view.line >= 0
        ? { path, line: view.line }
        : { path },
    );
  }
  return mapped;
};

/* ---------- 5) 公开 API -------------------------------------------------- */

/** 取 ACP 工具调用的稳定主键；缺失时返回空串（调用方应据此跳过）。 */
export const getAcpToolCallId = (update: TAcpAnyToolCall): string =>
  asString(asView(update).toolCallId) ?? '';

export interface IReduceAcpToolCallOptions {
  /** 首次创建条目时写入 createdAt（ISO）；省略时用当前时刻。 */
  now?: string;
}

/**
 * ACP `tool_call` / `tool_call_update` → 协议 VM `IAiThreadToolCall` 的归并器。
 * 以 `toolCallId` 为键 upsert：`previous` 为空建条目，否则仅覆盖本次出现的字段；
 * `content` / `locations` 一旦出现即整体替换（对齐 ACP 语义）。纯函数，不修改入参。
 */
export const reduceAcpToolCall = (
  previous: IAiThreadToolCall | undefined,
  update: TAcpAnyToolCall,
  options: IReduceAcpToolCallOptions = {},
): IAiThreadToolCall => {
  const view = asView(update);
  const id = asString(view.toolCallId) ?? previous?.id ?? '';
  const title = asString(view.title);
  const status = mapStatus(view.status);
  const hasKind = typeof view.kind === 'string';
  const hasContent = view.content !== undefined;
  const locations = mapLocations(view.locations);
  const locationsPatch = locations !== undefined ? { locations } : {};
  const rawInputPatch = view.rawInput !== undefined ? { rawInput: view.rawInput } : {};
  const rawOutputPatch = view.rawOutput !== undefined ? { rawOutput: view.rawOutput } : {};

  if (previous === undefined) {
    return {
      type: 'tool_call',
      id,
      createdAt: options.now ?? new Date().toISOString(),
      title: title ?? '',
      kind: mapKind(view.kind),
      status: status ?? 'pending',
      content: hasContent ? mapContent(view.content, id) : [],
      ...locationsPatch,
      ...rawInputPatch,
      ...rawOutputPatch,
    };
  }

  return {
    ...previous,
    id,
    title: title ?? previous.title,
    kind: hasKind ? mapKind(view.kind) : previous.kind,
    status: status ?? previous.status,
    content: hasContent ? mapContent(view.content, id) : previous.content,
    ...locationsPatch,
    ...rawInputPatch,
    ...rawOutputPatch,
  };
};
