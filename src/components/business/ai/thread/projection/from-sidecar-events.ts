/* ============================================================================
 * 边车 UI 事件 → reduce 规范化事件映射器（ADR-0014 Step 5a，纯函数）
 *
 * 把单条 TAgentUiEvent（含内嵌 TAgentRuntimeEvent）映射为 0..n 条
 * TAiThreadReduceEvent，供监听层喂给 reduceThread。本文件不订阅、不持状态、不接线
 * ——仅做无副作用转换，可独立单测；接线（5b）另起一刀。
 *
 * 覆盖 Mastra 内建流式主路径：
 *  - 正文 / 思维链增量（agent.text.delta / agent.reasoning.delta、顶层 message_delta；
 *    message_delta 按 phase 分流：'stage'→思维链(thought)，'final'/缺省→正文(message)）
 *  - 工具起止 / 取消 / 进度（agent.tool.started / completed / progress）；工具 I/O 预览作为 content 块落地
 *  - 上下文压缩完成（acontext.context_compaction.completed）
 *  - 回合完成 / 错误（agent.run.completed / error、顶层 done / error）
 *
 * 有意暂不覆盖（对齐迁移范围“plan 省略 + 5 项留空”，留待后续 slice）：
 *  - plan_ready / plan_record：计划条目本次迁移省略；
 *  - diff_ready：需 IAiAgentPatchSummary 全字段，运行时帧不足以无损构造；
 *  - ACP tool_call / tool_call_update：走既有 applyAcpUiEvent 累加器投影为完整
 *    IAiThreadToolCall，粗粒度 reduce 工具事件无法承载其 content / diff / locations；
 *  - 旧粗粒度 tool_start / tool_result：缺稳定 id，不臆造；
 *  - agent.tool.progress 纯心跳（无 dataPreview）：无 content，忽略；带 dataPreview 者已作为内容落地；
 *  - mode / usage / commands / config / approval / ask_user 等非线程条目信号。
 *
 * 时间戳取运行时事件内联 timestamp；顶层事件无时间戳，用 options.now。
 * ========================================================================== */
import {
  describeRunEvent,
  describeToolAction,
} from '@/components/business/ai/plan/runtime-timeline';
import { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';
import type { TAiAssistantChannel, TAiThreadReduceEvent } from '@/store/aiThread/events';
import type { TAgentRuntimeEvent, TAgentUiEvent } from '@/types/ai/sidecar';
import type { IAiThreadToolCallContent } from '@/types/ai/thread';

import { RUNTIME_KIND_TO_TOOL_KIND } from './tool-kind';

export interface ISidecarToReduceOptions {
  /** 顶层无内联时间戳事件（message_delta / done / error）的 createdAt（ISO）。 */
  now: string;
  /** 本回合 assistant 消息 id（监听层按回合分配，正文与思维链共用同一条消息）。 */
  assistantMessageId: string;
}

/** 运行时 result.status 原值是否表示“取消”（success / error / cancelled…）。 */
const isCancelStatus = (status: string | undefined): boolean =>
  typeof status === 'string' && status.toLowerCase().includes('cancel');

/** 文本增量 → assistant_delta；空文本忽略（不产生无意义条目变更）。 */
const toAssistantDelta = (
  channel: TAiAssistantChannel,
  messageId: string,
  createdAt: string,
  text: string,
): TAiThreadReduceEvent[] =>
  text.length > 0 ? [{ kind: 'assistant_delta', messageId, createdAt, channel, text }] : [];

/** 工具 I/O 预览文本 → tool-call 内容（text 内容块）；空文本返回 undefined（不附内容）。 */
const toToolOutputContent = (text: string | undefined): IAiThreadToolCallContent[] | undefined =>
  text !== undefined && text.length > 0
    ? [{ type: 'content', block: { type: 'text', text } }]
    : undefined;

/**
 * 顶层 message_delta.phase → assistant 通道。
 * ACP 宿主（src-tauri/src/acp/ui_event.rs）把外部 agent（Kimi/Codex）的 agent_thought_chunk
 * 映射为 message_delta{phase:'stage'}、agent_message_chunk 映射为 message_delta{phase:'final'}。
 * 故仅显式 'stage'（推理态）进思维链(thought)；'final' 与缺省（无 phase 的旧/内建发射）按正文(message)，
 * 与既有行为等价。
 */
const messageDeltaChannel = (
  phase: Extract<TAgentUiEvent, { type: 'message_delta' }>['phase'],
): TAiAssistantChannel => (phase === 'stage' ? 'thought' : 'message');

const fromRuntimeEvent = (
  event: TAgentRuntimeEvent,
  options: ISidecarToReduceOptions,
): TAiThreadReduceEvent[] => {
  switch (event.type) {
    case 'agent.text.delta':
      return toAssistantDelta('message', options.assistantMessageId, event.timestamp, event.text);
    case 'agent.reasoning.delta':
      return toAssistantDelta('thought', options.assistantMessageId, event.timestamp, event.text);
    case 'agent.tool.started':
      return [
        {
          kind: 'tool_started',
          id: event.toolUseId ?? event.id,
          createdAt: event.timestamp,
          // 标题经 presenter 语义化（与 OLD buildTimelineItems 同源），消除前向通路「原始工具名」信息丢失。
          title: describeToolAction(event, event.toolName).action,
          // 工具原始名（raw toolName）原样贯通到 reduce；渲染层 name 用它而非语义化 title。
          ...(event.toolName ? { name: event.toolName } : {}),
          toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(event.toolName)],
          status: 'in_progress',
        },
      ];
    case 'agent.tool.completed': {
      const toolUseId = event.toolUseId ?? event.id;
      if (isCancelStatus(event.status)) {
        return [{ kind: 'tool_canceled', id: toolUseId }];
      }
      // 完成阶段标题经同源 presenter 语义化：完成后由「正在…」刷新为「已完成 / 失败」措辞。
      const title = describeToolAction(event, event.toolName).action;
      const appendContent = toToolOutputContent(
        event.ok ? event.resultPreview : (event.errorMessage ?? event.resultPreview),
      );
      if (appendContent === undefined) {
        return [{ kind: 'tool_completed', id: toolUseId, ok: event.ok, title }];
      }
      return [{ kind: 'tool_completed', id: toolUseId, ok: event.ok, title, appendContent }];
    }
    case 'agent.tool.progress': {
      const appendContent = toToolOutputContent(event.dataPreview);
      if (appendContent === undefined) {
        return [];
      }
      return [{ kind: 'tool_progress', id: event.toolUseId ?? event.id, appendContent }];
    }
    case 'acontext.context_compaction.completed': {
      // 压缩文案经 presenter（describeRunEvent）语义化，消除前向通路「兜底占位文案」信息丢失。
      const message = describeRunEvent(event) ?? undefined;
      return [
        {
          kind: 'context_compaction',
          id: event.compactionId,
          createdAt: event.timestamp,
          ...(message !== undefined ? { message } : {}),
        },
      ];
    }
    case 'agent.run.completed':
      return [{ kind: 'stream_completed' }];
    case 'agent.run.error':
      return [{ kind: 'stream_error', message: event.errorMessage }];
    default:
      // 其余运行时事件（run.started / model.* / acontext.* 非 completed /
      // checkpoint / rollback / side_effect / message.added / debug）当前 reduce 模型不消费。
      return [];
  }
};

/** 单条边车 UI 事件 → 0..n 条 reduce 规范化事件。纯函数，不修改入参、无副作用。 */
export const sidecarEventToReduceEvents = (
  event: TAgentUiEvent,
  options: ISidecarToReduceOptions,
): TAiThreadReduceEvent[] => {
  switch (event.type) {
    case 'message_delta':
      return toAssistantDelta(
        messageDeltaChannel(event.phase),
        options.assistantMessageId,
        options.now,
        event.text,
      );
    case 'agent_event':
      return fromRuntimeEvent(event.event, options);
    case 'done':
      return [{ kind: 'stream_completed' }];
    case 'error':
      return [{ kind: 'stream_error', message: event.message }];
    default:
      // 见文件头“有意暂不覆盖”：plan_* / tool_start / tool_result / tool_call(_update) /
      // mode_update / available_commands_update / usage_update / config_option_update /
      // approval_required / ask_user_required / diff_ready。
      return [];
  }
};
