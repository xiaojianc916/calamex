import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

const { getSessionConfigOptions, setSessionConfigOption } = vi.hoisted(() => ({
  getSessionConfigOptions: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    getSessionConfigOptions,
    setSessionConfigOption,
  },
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
  });

  it('loads and parses config options, flattening grouped options', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.loadConfigOptions('thread-1');

    expect(getSessionConfigOptions).toHaveBeenCalledWith({ threadId: 'thread-1' });
    expect(vm.hasConfigOptions.value).toBe(true);
    expect(vm.configOptions.value).toHaveLength(2);
    const mode = vm.configOptions.value.find((o) => o.id === 'mode');
    expect(mode?.options).toEqual([
      { value: 'ask', name: 'Ask', group: 'Standard' },
      { value: 'code', name: 'Code', group: 'Standard' },
    ]);
  });

  it('sets state to null when payload is null', async () => {
    getSessionConfigOptions.mockResolvedValue(null);
    const vm = withScope(() => useAcpSessionConfigOptions());

    await vm.loadConfigOptions('thread-1');

    expect(vm.state.value).toBeNull();
    expect(vm.hasConfigOptions.value).toBe(false);
  });

  it('discards stale load results when the thread switched mid-flight', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    getSessionConfigOptions
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());

    const first = vm.loadConfigOptions('thread-1');
    await vm.loadConfigOptions('thread-2');
    resolveFirst?.({ configOptions: [] });
    await first;

    // thread-2 的结果应保留，不被过期的 thread-1 覆盖。
    expect(vm.configOptions.value).toHaveLength(2);
  });

  it('optimistically updates currentValue and calls the IPC', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    setSessionConfigOption.mockResolvedValue(true);
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');

    expect(ok).toBe(true);
    expect(setSessionConfigOption).toHaveBeenCalledWith({
      threadId: 'thread-1',
      configId: 'model',
      valueId: 'k1',
    });
    expect(vm.configOptions.value.find((o) => o.id === 'model')?.currentValue).toBe('k1');
  });

  it('rolls back when the IPC returns false', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    setSessionConfigOption.mockResolvedValue(false);
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');

    expect(ok).toBe(false);
    expect(vm.configOptions.value.find((o) => o.id === 'model')?.currentValue).toBe('k2');
  });

  it('rolls back and rethrows when the IPC throws', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    setSessionConfigOption.mockRejectedValue(new Error('boom'));
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    await expect(vm.selectConfigOption('thread-1', 'model', 'k1')).rejects.toThrow('boom');
    expect(vm.configOptions.value.find((o) => o.id === 'model')?.currentValue).toBe('k2');
    expect(vm.isSwitching.value).toBe(false);
  });

  it('rejects unknown configId / valueId without calling the IPC', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    expect(await vm.selectConfigOption('thread-1', 'missing', 'k1')).toBe(false);
    expect(await vm.selectConfigOption('thread-1', 'model', 'nope')).toBe(false);
    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('replaces state from the full snapshot on config_option_update', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    vm.applyConfigOptionUpdate([
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
    ]);

    expect(vm.configOptions.value).toHaveLength(1);
    expect(vm.configOptions.value[0]?.currentValue).toBe('k1');
  });

  it('keeps previous state when config_option_update carries a bad frame', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    vm.applyConfigOptionUpdate('not-an-array');

    expect(vm.configOptions.value).toHaveLength(2);
  });

  it('resets state', async () => {
    getSessionConfigOptions.mockResolvedValue({ configOptions: buildConfigOptions() });
    const vm = withScope(() => useAcpSessionConfigOptions());
    await vm.loadConfigOptions('thread-1');

    vm.reset();

    expect(vm.state.value).toBeNull();
    expect(vm.hasConfigOptions.value).toBe(false);
  });
});
