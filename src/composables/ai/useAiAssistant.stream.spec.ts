import { describe, expect, it } from 'vitest';

import { createSidecarLiveEventBuffer } from '@/composables/ai/useAiAssistant.stream';
import type { TAgentUiEvent } from '@/types/ai/sidecar';

const messageDelta = (text: string, phase: 'stage' | 'final' = 'final'): TAgentUiEvent => ({
  type: 'message_delta',
  text,
  phase,
});

const finalMessageDeltas = (events: readonly TAgentUiEvent[]) =>
  events.filter(
    (event): event is Extract<TAgentUiEvent, { type: 'message_delta' }> =>
      event.type === 'message_delta' && event.phase === 'final',
  );

describe('createSidecarLiveEventBuffer', () => {
  it('accumulates incremental final message_delta fragments into a single cumulative event', () => {
    const buffer = createSidecarLiveEventBuffer(() => {});

    buffer.push(messageDelta('日子缓缓'));
    buffer.flush();
    buffer.push(messageDelta('向前，风掠过街'));
    buffer.flush();
    buffer.push(messageDelta('巷与黄昏，不必追'));
    buffer.flush();

    const finalDeltas = finalMessageDeltas(buffer.events);

    // 累计文本,而不是只保留最新片段(否则会出现“逐段替换”的回归)。
    expect(finalDeltas[0]?.text).toBe('日子缓缓向前，风掠过街巷与黄昏，不必追');
    expect(finalDeltas).toHaveLength(1);
  });

  it('accumulates fragments that are coalesced within the same flush frame', () => {
    const buffer = createSidecarLiveEventBuffer(() => {});

    buffer.push(messageDelta('守好自己'));
    buffer.push(messageDelta('的节奏'));
    buffer.flush();

    const finalDeltas = finalMessageDeltas(buffer.events);

    expect(finalDeltas[0]?.text).toBe('守好自己的节奏');
    expect(finalDeltas).toHaveLength(1);
  });

  it('keeps stage and final phases as independent accumulators', () => {
    const buffer = createSidecarLiveEventBuffer(() => {});

    buffer.push(messageDelta('思考A', 'stage'));
    buffer.flush();
    buffer.push(messageDelta('答案A'));
    buffer.flush();
    buffer.push(messageDelta('思考B', 'stage'));
    buffer.flush();
    buffer.push(messageDelta('答案B'));
    buffer.flush();

    expect(finalMessageDeltas(buffer.events)[0]?.text).toBe('答案A答案B');

    const stageEvent = buffer.events.find(
      (event): event is Extract<TAgentUiEvent, { type: 'message_delta' }> =>
        event.type === 'message_delta' && event.phase === 'stage',
    );
    expect(stageEvent?.text).toBe('思考A思考B');
  });

  it('dispose 后忽略迟到 sidecar 事件，避免取消/切屏后的旧事件回写 UI', () => {
    let flushCount = 0;
    const buffer = createSidecarLiveEventBuffer(() => {
      flushCount += 1;
    });

    buffer.push(messageDelta('取消前'));
    buffer.flush();
    expect(flushCount).toBe(1);

    buffer.dispose();
    buffer.push(messageDelta('迟到内容'));
    buffer.flush();

    expect(flushCount).toBe(1);
    expect(buffer.events).toHaveLength(0);
  });
});
