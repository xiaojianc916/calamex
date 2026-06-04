import {
  AGENT_RUNTIME_OUTPUT_EVENT_TYPES,
  type TAgentRuntimeOutputEvent,
} from '../engines/contracts/runtime-contracts.js';
import type { TPlanOrchestrationWorkflow } from '../engines/plan/orchestration-workflow.js';

// committed orchestration workflow 的 run 实例类型（createRun 可能同步或异步返回，统一 Awaited）。
export type TPlanOrchestrationRun = Awaited<ReturnType<TPlanOrchestrationWorkflow['createRun']>>;

// Orchestration is enabled by default; it is disabled only when
// AGENT_ORCHESTRATION_WORKFLOW is explicitly set to '0' or 'false'. The flag was
// only an off-by-default migration gate while the per-phase channel was primary;
// the native orchestration channel is now the default path.
export const isOrchestrationWorkflowDisabled = (): boolean => {
  const raw = (process.env.AGENT_ORCHESTRATION_WORKFLOW ?? '').trim().toLowerCase();
  return raw === '0' || raw === 'false';
};

// 编排 workflow 各 step 通过 step writer 写入内层 agent 运行时事件，Mastra 会把它包进
// 形如 { type: 'workflow-step-output', payload: { output: <event> } } 的 chunk。这里只透出
// 白名单（AGENT_RUNTIME_OUTPUT_EVENT_TYPES，共 11 类）内的运行时事件，丢弃所有 Mastra
// 内部生命周期 chunk（step-start / step-result / workflow-* 等），使流式输出帧与既有 /stream
// 路由完全同构（{ type: 'event', event }）。
const isRuntimeOutputEvent = (value: unknown): value is TAgentRuntimeOutputEvent => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidateType = (value as { type?: unknown }).type;
  return (
    typeof candidateType === 'string'
    && (AGENT_RUNTIME_OUTPUT_EVENT_TYPES as readonly string[]).includes(candidateType)
  );
};

// 从 workflow chunk 中提取内层 agent 事件：优先 payload.output（step writer 主路径），
// 再回退 payload、chunk 自身；任一命中 11 类白名单即返回，否则视为内部帧并丢弃（undefined）。
export const extractOrchestrationAgentEvent = (
  chunk: unknown,
): TAgentRuntimeOutputEvent | undefined => {
  if (!chunk || typeof chunk !== 'object') {
    return undefined;
  }
  const payload = (chunk as { payload?: unknown }).payload;
  const output = payload && typeof payload === 'object'
    ? (payload as { output?: unknown }).output
    : undefined;
  if (isRuntimeOutputEvent(output)) {
    return output;
  }
  if (isRuntimeOutputEvent(payload)) {
    return payload;
  }
  if (isRuntimeOutputEvent(chunk)) {
    return chunk;
  }
  return undefined;
};
