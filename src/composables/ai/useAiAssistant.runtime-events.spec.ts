import { describe, expect, it } from 'vitest';

import { extractVisibleAgentRuntimeEvents } from '@/composables/ai/useAiAssistant.runtime-events';
import type { TAgentUiEvent } from '@/types/ai/sidecar';

describe('extractVisibleAgentRuntimeEvents', () => {
  it('保留 token 诊断事件给时间线和上下文预算读取，但不放开普通 debug 事件', () => {
    const events: TAgentUiEvent[] = [
      {
        type: 'agent_event',
        event: {
          id: 'provider-payload',
          type: 'acontext.provider_payload.checked',
          runId: 'run-1',
          sessionId: 'session-1',
          agentId: 'agent-1',
          timestamp: '2026-05-02T10:00:00.000Z',
          seq: 0,
          schemaVersion: 1,
          redacted: true,
          visibility: 'debug',
          provider: 'deepseek',
          requestIndex: 1,
          requestBodyCharCount: 1200,
          projectedInputTokens: 300,
          projectedInputTokensAvailable: true,
          messageCharCount: 800,
          systemMessageCharCount: 100,
          userMessageCharCount: 200,
          assistantMessageCharCount: 300,
          toolMessageCharCount: 200,
          reasoningReplayCharCount: 0,
          toolSchemaCharCount: 200,
          toolCount: 2,
          responseFormatCharCount: 0,
          reasoningInjected: false,
          tokenEstimateMethod: 'char_heuristic',
        },
      },
      {
        type: 'agent_event',
        event: {
          id: 'debug-noise',
          type: 'agent.debug',
          runId: 'run-1',
          sessionId: 'session-1',
          agentId: 'agent-1',
          timestamp: '2026-05-02T10:00:01.000Z',
          seq: 1,
          schemaVersion: 1,
          redacted: true,
          visibility: 'debug',
          name: 'internal.metric',
        },
      },
    ];

    expect(extractVisibleAgentRuntimeEvents(events).map((event) => event.id)).toEqual([
      'provider-payload',
    ]);
  });
});
