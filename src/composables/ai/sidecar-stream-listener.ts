import { aiService } from '@/services/ipc/ai.service';
import type { TAgentUiEvent } from '@/types/ai/sidecar';

/**
 * 订阅 sidecar 流式事件，并按 sessionId 过滤。
 * 收敛 useAiAssistant / useAiAgentRun 中重复的 onSidecarStream + sessionId 守卫样板。
 * 返回的 Promise resolve 为取消订阅函数。
 */
export const subscribeSidecarSessionStream = (
  sessionId: string,
  onEvent: (event: TAgentUiEvent) => void,
) =>
  aiService.onSidecarStream((payload) => {
    if (payload.sessionId !== sessionId) {
      return;
    }

    onEvent(payload.event);
  });
