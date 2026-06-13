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

/**
 * 在已知 sessionId 之前就订阅 sidecar 流:先缓冲全部帧,bind(sessionId) 后回放匹配帧
 * 并继续转发后续匹配帧。消除「先 await chatStream → 再订阅」之间的丢帧窗口(零竞态)。
 */
export interface IBufferedSidecarSessionStream {
  bind(sessionId: string): void;
  dispose(): void;
}

export const subscribeSidecarStreamWithPrebuffer = async (
  onEvent: (event: TAgentUiEvent) => void,
): Promise<IBufferedSidecarSessionStream> => {
  const buffered: Array<{ sessionId: string; event: TAgentUiEvent }> = [];
  let boundSessionId: string | null = null;

  const unlisten = await aiService.onSidecarStream((payload) => {
    if (boundSessionId === null) {
      buffered.push({ sessionId: payload.sessionId, event: payload.event });
      return;
    }

    if (payload.sessionId !== boundSessionId) {
      return;
    }

    onEvent(payload.event);
  });

  return {
    bind(sessionId: string): void {
      if (boundSessionId !== null) {
        return;
      }

      boundSessionId = sessionId;

      for (const frame of buffered.splice(0)) {
        if (frame.sessionId === sessionId) {
          onEvent(frame.event);
        }
      }
    },
    dispose(): void {
      buffered.length = 0;
      unlisten();
    },
  };
};
