import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

const { ensureAcpSession, setSessionConfigOption, subscribeSidecarSessionStream } = vi.hoisted(
  () => ({
    ensureAcpSession: vi.fn(),
    setSessionConfigOption: vi.fn(),
    subscribeSidecarSessionStream: vi.fn(),
  }),
);

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    ensureAcpSession,
    setSessionConfigOption,
  },
}));

vi.mock('@/composables/ai/sidecar-stream-listener', () => ({
  subscribeSidecarSessionStream,
}));

import { useAcpSessionConfigOptions } from '@/composables/ai/useAcpSessionConfigOptions';

function buildConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'k2',
      options: [
        { value: 'k2', name: 'Kimi K2' },
        { value: 'k1', name: 'Kimi K1', description: 'Legacy' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'ask',
      options: [
        {
          group: 'standard',
          name: 'Standard',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'code', name: 'Code' },
          ],
        },
      ],
    },
  ];
}

function withScope<T>(fn: () => T): T {
  const scope = effectScope();
  const result = scope.run(fn);
  if (result === undefined) throw new Error('scope.run returned undefined');
  return result;
}

describe('useAcpSessionConfigOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    subscribeSidecarSessionStream.mockResolvedValue(() => {});
  });

  it('handshakes, enters discovering, then resolves to empty ready after grace', async () => {
    vi.useFakeTimers();
    ensureAcpSession.mockResolvedValue(undefined);
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(ensureAcpSession).toHaveBeenCalledWith({ threadId: 'thread-1', backend: 'kimi' });
    expect(subscribeSidecarSessionStream).toHaveBeenCalledWith(
      'config:thread-1',
      expect.any(Function),
    );
    expect(vm.state.value.kind).toBe('discovering');

    await vi.advanceTimersByTimeAsync(1200);
    expect(vm.state.value).toEqual({ kind: 'ready', configOptions: [] });
    expect(vm.hasConfigOptions.value).toBe(false);
  });

  it('applies a pre-prompt config_option_update arriving on the session config stream', async () => {
    ensureAcpSession.mockResolvedValue(undefined);
    let streamHandler: ((event: unknown) => void) | null = null;
    subscribeSidecarSessionStream.mockImplementation((_sessionId: string, onEvent) => {
      streamHandler = onEvent;
      return Promise.resolve(() => {});
    });
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');
    expect(vm.state.value.kind).toBe('discovering');

    streamHandler?.({ type: 'config_option_update', configOptions: buildConfigOptions() });

    expect(vm.state.value.kind).toBe('ready');
    expect(vm.configOptions.value).toHaveLength(2);
  });

  it('marks unavailable when the handshake throws', async () => {
    ensureAcpSession.mockRejectedValue(new Error('boom'));
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.ensureAcpSession('thread-1', 'kimi');

    expect(vm.state.value.kind).toBe('unavailable');
  });

  it('parses config_option_update into ready, flattening grouped options', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());

    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(vm.state.value.kind).toBe('ready');
    expect(vm.configOptions.value).toHaveLength(2);
    const mode = vm.configOptions.value.find((o) => o.id === 'mode');
    expect(mode?.options).toEqual([
      { value: 'ask', name: 'Ask', group: 'Standard' },
      { value: 'code', name: 'Code', group: 'Standard' },
    ]);
  });

  it('keeps previous state when config_option_update carries a bad frame', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    vm.applyConfigOptionUpdate('not-an-array');

    expect(vm.configOptions.value).toHaveLength(2);
  });

  it('fires set without optimistic mutation and merges the returned snapshot', async () => {
    setSessionConfigOption.mockResolvedValue({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'k1',
          options: [
            { value: 'k2', name: 'Kimi K2' },
            { value: 'k1', name: 'Kimi K1' },
          ],
        },
      ],
    });
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');

    expect(ok).toBe(true);
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      threadId: 'thread-1',
      configId: 'model',
      valueId: 'k1',
    });
    expect(vm.configOptions.value.find((o) => o.id === 'model')?.currentValue).toBe('k1');
  });

  it('rejects unknown configId / valueId without calling the IPC', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(await vm.selectConfigOption('thread-1', 'missing', 'k1')).toBe(false);
    expect(await vm.selectConfigOption('thread-1', 'model', 'nope')).toBe(false);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('returns true without IPC when selecting the current value', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    expect(await vm.selectConfigOption('thread-1', 'model', 'k2')).toBe(true);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('resets state to idle', async () => {
    const vm = withScope(() => useAcpSessionConfigOptions());
    vm.applyConfigOptionUpdate(buildConfigOptions());

    vm.reset();

    expect(vm.state.value).toEqual({ kind: 'idle' });
    expect(vm.hasConfigOptions.value).toBe(false);
  });
});
