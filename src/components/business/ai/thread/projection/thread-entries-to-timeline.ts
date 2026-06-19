/**
 * 数据模型 IAiThreadEntry[](reduce 真源)-> 平铺渲染时间线 TAiThreadEntry[] 的纯投影。
 *
 * 与 build-thread-entries.ts 互补:后者输入是遗留 IAiChatMessage[](双轨期旧路径),
 * 本函数输入是新数据模型 entries(reduce 驱动),供 renderFromEntries=true 时渲染层消费。
 *
 * 本片范围(Step 6 骨架,刻意最小化、可逆):
 * - plan 条目暂不进平铺时间线(计划步骤仍由 deriveThreadPlanDetails 的独立面板渲染),故跳过。
 * - plan_control 审批卡投影为 plan-control 条目并入平铺时间线。
 * - user-message 的 references 由数据模型透传(reduce / legacy-adapter 已携带)。
 * - tool-call 的 terminals 暂为空、awaiting 暂为 false(终端快照重建与 HITL 等待留后续)。
 * - changed-files 仅产出末尾汇总条目,不把 diff 内联到工具条目(数据模型未存 patches)。
 * - streaming 由调用方经 options.streamingMessageId 注入,纯函数默认 false。
 * 以上留白均不改变旧路径行为;切回 renderFromEntries=false 即恢复遗留投影。
 */
import type {
  IAiThreadAssistantMessageEntry,
  IAiThreadContentBlock,
  IAiThreadEntry,
} from '@/types/ai/thread';

import type {
  IAiThreadAssistantTextEntry,
  IAiThreadReasoningEntry,
  TAiThreadEntry,
} from './entry-types';

/** 段落分隔符:多个文本块之间以空行连接。 */
const PARAGRAPH_BREAK = '\n\n';

/** context_compaction 无显式文案时的兜底展示文本。 */
export const DEFAULT_CONTEXT_COMPACTION_TEXT = '已整理上下文以释放空间';

export interface IThreadEntriesToTimelineOptions {
  /** 正在流式输出的来源消息 id;命中的 assistant 条目标记 streaming=true。 */
  streamingMessageId?: string | null;
}

/** 取内容块的纯文本(仅 text 块产出文本;富块留待后续切片)。 */
function blockToText(block: IAiThreadContentBlock): string {
  return block.type === 'text' ? block.text : '';
}

/** 拼接内容块为 markdown(忽略空文本块,段间以空行分隔)。 */
function blocksToMarkdown(blocks: readonly IAiThreadContentBlock[]): string {
  return blocks
    .map(blockToText)
    .filter((text) => text.length > 0)
    .join(PARAGRAPH_BREAK);
}

/** 把一条 assistant_message 拆为 reasoning(thought)与 assistant-text(message)两类条目。 */
function assistantMessageToEntries(
  entry: IAiThreadAssistantMessageEntry,
  streaming: boolean,
): TAiThreadEntry[] {
  const thoughtSegments: string[] = [];
  const messageTexts: string[] = [];
  for (const chunk of entry.chunks) {
    const text = blockToText(chunk.block);
    if (text.length === 0) {
      continue;
    }
    if (chunk.type === 'thought') {
      thoughtSegments.push(text);
    } else {
      messageTexts.push(text);
    }
  }

  const projected: TAiThreadEntry[] = [];
  if (thoughtSegments.length > 0) {
    const reasoning: IAiThreadReasoningEntry = {
      kind: 'reasoning',
      id: `${entry.id}:reasoning`,
      messageId: entry.id,
      segments: thoughtSegments,
      // 与 runtime 时间线对齐:多段(>1)才视为长推理,渲染层默认折叠。
      isLong: thoughtSegments.length > 1,
      streaming,
    };
    projected.push(reasoning);
  }
  if (messageTexts.length > 0) {
    const assistantText: IAiThreadAssistantTextEntry = {
      kind: 'assistant-text',
      id: `${entry.id}:text`,
      messageId: entry.id,
      markdown: messageTexts.join(PARAGRAPH_BREAK),
      streaming,
    };
    projected.push(assistantText);
  }
  return projected;
}

/**
 * 把数据模型 entries 投影为平铺渲染时间线。纯函数、无副作用、保持输入顺序。
 */
export function threadEntriesToTimeline(
  entries: readonly IAiThreadEntry[],
  options: IThreadEntriesToTimelineOptions = {},
): TAiThreadEntry[] {
  const streamingMessageId = options.streamingMessageId ?? null;
  const timeline: TAiThreadEntry[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case 'user_message': {
        timeline.push({
          kind: 'user-message',
          id: entry.id,
          messageId: entry.id,
          markdown: blocksToMarkdown(entry.content),
          references: entry.references,
        });
        break;
      }
      case 'assistant_message': {
        const streaming = streamingMessageId !== null && entry.id === streamingMessageId;
        for (const projected of assistantMessageToEntries(entry, streaming)) {
          timeline.push(projected);
        }
        break;
      }
      case 'tool_call': {
        timeline.push({
          kind: 'tool-call',
          id: entry.id,
          messageId: entry.id,
          toolCall: entry,
          terminals: {},
          awaiting: false,
        });
        break;
      }
      case 'plan': {
        // 本片刻意跳过:plan 步骤由独立面板渲染,不进平铺时间线。
        break;
      }
      case 'plan_control': {
        timeline.push({
          kind: 'plan-control',
          id: entry.id,
          messageId: entry.id,
          goal: entry.goal,
          references: entry.references,
          phase: entry.phase,
        });
        break;
      }
      case 'context_compaction': {
        timeline.push({
          kind: 'context-compaction',
          id: entry.id,
          messageId: entry.id,
          text: entry.message ?? DEFAULT_CONTEXT_COMPACTION_TEXT,
        });
        break;
      }
      case 'changed_files': {
        timeline.push({
          kind: 'changed-files-summary',
          id: entry.id,
          messageId: entry.id,
          summary: entry.summary,
        });
        break;
      }
      default: {
        const _exhaustive: never = entry;
        return _exhaustive;
      }
    }
  }

  return timeline;
}
