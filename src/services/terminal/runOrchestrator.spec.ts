import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  afterEach(() => {
    vi.useRealTimers();
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

  it('manages completion fallback timer through a replaceable disposable', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const orchestrator = getTerminalRunOrchestrator();
    const internals = orchestrator as unknown as {
      scheduleTerminalRunCompletionTimeout(runId: string): void;
      clearTerminalRunFallbackTimer(): void;
      terminalRunFallbackTimer: { value: unknown };
    };

    internals.scheduleTerminalRunCompletionTimeout('run-1');
    const firstTimer = internals.terminalRunFallbackTimer.value;

    expect(firstTimer).toBeTypeOf('function');

    internals.scheduleTerminalRunCompletionTimeout('run-2');
    await Promise.resolve();

    expect(internals.terminalRunFallbackTimer.value).not.toBe(firstTimer);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);

    internals.clearTerminalRunFallbackTimer();
    await Promise.resolve();

    expect(internals.terminalRunFallbackTimer.value).toBeNull();
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
  });
});
