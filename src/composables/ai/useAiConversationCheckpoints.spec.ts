import { mount } from '@vue/test-utils';
import { defineComponent, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import type { useAiAssistant } from '@/composables/ai/useAiAssistant';

import { useAiConversationCheckpoints } from './useAiConversationCheckpoints';

type AiAssistantApi = ReturnType<typeof useAiAssistant>;

const withSetup = <T>(factory: () => T): T => {
  let result: T | undefined;
  mount(
    defineComponent({
      setup() {
        result = factory();
        return () => null;
      },
    }),
  );

  if (result === undefined) {
    throw new Error('composable setup did not run');
  }

  return result;
};

const createAssistantStub = () => {
  const conversationCheckpoints = ref([
    {
      id: 'cp-1',
      messageId: 'm-1',
      runId: 'r-1',
      snapshotId: 's-1',
      sessionId: 'sess-1',
      createdAt: '2026-06-09T03:00:00.000Z',
    },
  ]);
  const restoringCheckpointId = ref<string | null>(null);
  const isSending = ref(false);
  const restoreConversationCheckpoint = vi.fn().mockResolvedValue(undefined);

  const assistant = {
    conversationCheckpoints,
    restoringCheckpointId,
    isSending,
    restoreConversationCheckpoint,
  } as unknown as AiAssistantApi;

  return { assistant, restoringCheckpointId, isSending, restoreConversationCheckpoint };
};

describe('useAiConversationCheckpoints', () => {
  it('按消息 ID 索引检查点', () => {
    const { assistant } = createAssistantStub();
    const checkpoints = withSetup(() => useAiConversationCheckpoints(assistant));

    expect(checkpoints.getConversationCheckpoint('m-1')?.id).toBe('cp-1');
    expect(checkpoints.getConversationCheckpoint('missing')).toBeNull();
  });

  it('未恢复时返回检查点时间标签', () => {
    const { assistant } = createAssistantStub();
    const checkpoints = withSetup(() => useAiConversationCheckpoints(assistant));

    expect(checkpoints.getConversationCheckpointLabel('m-1')).toMatch(/^恢复到 .+ 检查点$/);
    expect(checkpoints.getConversationCheckpointLabel('missing')).toBe('');
  });

  it('正在恢复时返回恢复中文案并标记状态', () => {
    const { assistant, restoringCheckpointId } = createAssistantStub();
    const checkpoints = withSetup(() => useAiConversationCheckpoints(assistant));

    restoringCheckpointId.value = 'cp-1';

    expect(checkpoints.getConversationCheckpointLabel('m-1')).toBe('正在恢复检查点');
    expect(checkpoints.isConversationCheckpointRestoring('m-1')).toBe(true);
    expect(checkpoints.isConversationCheckpointDisabled.value).toBe(true);
  });

  it('发送中时禁用检查点