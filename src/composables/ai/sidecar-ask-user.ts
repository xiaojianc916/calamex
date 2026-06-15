import type {
  IAgentSidecarAskUserResumeRequest,
  IAgentSidecarResponsePayload,
  IAskUserQuestion,
  IAskUserResult,
  TAgentUiEvent,
} from '@/types/ai/sidecar';

/* ============================================================================
 * 前端 ask_user 反向提问桥接（Human-in-the-Loop）。
 *
 * 职责对齐后端 `agent-sidecar/src/acp/approval-bridge.ts`：把「响应信封里的挂起
 * 事件」与「续跑回灌请求」之间的双向投影收拢到一个纯函数模块，与驱动循环
 * （useAiAssistant 的 run-to-gate 段）解耦，便于单测。
 *
 * 关键事实（与已读源码一致，不自创）：
 * - ask_user 不进 live SessionUpdate 流（见 acp/from-runtime-event.ts 只投影
 *   text/reasoning/tool/plan）；它随 `ask_user_required` UI 事件写进响应信封，
 *   与 `approval_required` 同属「信封承载的挂起点」。
 * - 因此 ask_user 恢复走 run-to-gate 家族的姊妹通道 `calamex.dev/agent/ask-user/resume`
 *   （后端 acp/agent.ts handleAgentAskUserResume → runtime.resolveAskUser），
 *   而非 orchestrate 的固定 decision 枚举（无法承载结构化答案）。
 * - 恢复请求镜像 approval 的「Partial base + requestId」结构，但以 outcome +
 *   结构化 answers 取代 decision（见 @/types/ai/sidecar 的
 *   IAgentSidecarAskUserResumeRequest 与后端 agentAskUserResumeParamsSchema）。
 * ========================================================================== */

/** 投影出的待作答反向提问门（喂给 QuestionPrompt 的 props）。 */
export interface IAgentSidecarPendingAskUser {
  /** 原样回传到 resume 的稳定标识。 */
  requestId: string;
  /** 1-4 个问题（对齐 Gemini ask_user 上限）。 */
  questions: IAskUserQuestion[];
}

const isAskUserRequiredEvent = (
  event: TAgentUiEvent,
): event is Extract<TAgentUiEvent, { type: 'ask_user_required' }> =>
  event.type === 'ask_user_required';

/**
 * 从响应信封中提取待作答的反向提问门。镜像 sidecar-events.ts 的
 * extractPendingConfirmation：取首个 ask_user_required 事件（一个回合至多挂起一处）。
 * 无则返回 null。
 */
export const extractPendingAskUser = (
  response: IAgentSidecarResponsePayload,
): IAgentSidecarPendingAskUser | null => {
  const event = response.events.find(isAskUserRequiredEvent);
  if (!event) {
    return null;
  }
  return { requestId: event.requestId, questions: event.request.questions };
};

/**
 * 由用户作答结果构造 ask_user 恢复请求。
 *
 * - outcome `'cancelled'`（用户 Esc / 回合取消）：省略 answers。
 * - outcome `'selected'`：携带每题作答；空答案数组等价于跳过全部问题，语义合法，
 *   故仅在 answers 实际存在时写入（与后端 `.optional()` 对齐，避免显式 undefined
 *   触发 exactOptionalPropertyTypes 报错）。
 * - sessionId 仅在非空时写入（实时预览订阅用；缺省由宿主按 threadId 解析会话）。
 */
export const buildAskUserResumeRequest = (args: {
  requestId: string;
  result: IAskUserResult;
  sessionId?: string | null;
}): IAgentSidecarAskUserResumeRequest => {
  const { requestId, result, sessionId } = args;
  return {
    requestId,
    outcome: result.outcome,
    ...(sessionId ? { sessionId } : {}),
    ...(result.outcome === 'selected' && result.answers ? { answers: result.answers } : {}),
  };
};
