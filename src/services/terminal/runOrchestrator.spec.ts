import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import {
  __resetTerminalRunOrchestratorForTesting,
  getTerminalRunOrchestrator,
} from '@/services/terminal/runOrchestrator';

const createNotifier = () => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
});

describe('terminal run orchestrator', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    __resetTerminalRunOrchestratorForTesting();
  });

  it('returns an application-level singleton', () => {
    const first = getTerminalRunOrchestrator();
    const second = getTerminalRunOrchestrator();

    expect(first).toBe(second);
  });

  it('keeps run orchestration outside Vue component scope and rebinds UI context explicitly', async () => {
    const orchestrator = getTerminalRunOrchestrator();
    const notifier = createNotifier();
    const editorStore = {
      isRunning: true,
    };

    orchestrator.bind({
      canRun: computed(() => true),
      editorStore: editorStore as never,
      notifier,
    });

    await orchestrator.runScript();

    expect(notifier.warning).toHaveBeenCalledWith('已有脚本正在运行，请等待完成或先停止当前运行。');
  });
});
