import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import { useAcpSessionModes, type IUseAcpSessionModesReturn } from './useAcpSessionModes';

const { getSessionModes, setSessionMode } = vi.hoisted(() => ({
  getSessionModes: vi.fn(),
  setSessionMode: vi.fn(),
}));

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: { getSessionModes, setSessionMode },
}));

const buildModes = () => ({
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask' },
    { id: 'code', name: 'Code', description: 'Full autonomy' },
  ],
});

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpSessionModesReturn;
  scope.run(() => {
    api = useAcpSessionModes();
  });
  // biome-ignore lint/style/noNonNullAssertion: scope.run 同步赋值 api。
  return { api: api!, scope };
};

describe('useAcpSessionModes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionModes.mockResolvedValue({ modes: buildModes() });
    setSessionMode.mockResolvedValue(true);
  });

  it('loadModes 解析并填充选择器 VM', async () => {
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    expect(api.hasModes.value).toBe(true);
    expect(api.currentMode.value?.id).toBe('ask');
    expect(api.availableModes.value.map((mode) => mode.id)).toEqual(['ask', 'code']);
    scope.stop();
  });

  it('payload 为 null 时清空 VM', async () => {
    getSessionModes.mockResolvedValueOnce(null);
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    expect(api.state.value).toBeNull();
    expect(api.hasModes.value).toBe(false);
    scope.stop();
  });

  it('selectMode 乐观切换并按 thread 回投 modeId', async () => {
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    await api.selectMode('code');
    expect(setSessionMode).toHaveBeenCalledWith({ threadId: 'thread-1', modeId: 'code' });
    expect(api.currentMode.value?.id).toBe('code');
    scope.stop();
  });

  it('回投抛错时回滚到先前模式并重抛', async () => {
    setSessionMode.mockRejectedValueOnce(new Error('boom'));
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    await expect(api.selectMode('code')).rejects.toThrow('boom');
    expect(api.currentMode.value?.id).toBe('ask');
    scope.stop();
  });

  it('后端返回 false 时回滚', async () => {
    setSessionMode.mockResolvedValueOnce(false);
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    await api.selectMode('code');
    expect(api.currentMode.value?.id).toBe('ask');
    scope.stop();
  });

  it('未知模式或当前模式不触发回投', async () => {
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    await api.selectMode('ghost');
    await api.selectMode('ask');
    expect(setSessionMode).not.toHaveBeenCalled();
    scope.stop();
  });

  it('applyModeUpdate 命中可用模式更新高亮，未知忽略', async () => {
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    api.applyModeUpdate('code');
    expect(api.currentMode.value?.id).toBe('code');
    api.applyModeUpdate('ghost');
    expect(api.currentMode.value?.id).toBe('code');
    scope.stop();
  });

  it('reset 清空 VM', async () => {
    const { api, scope } = mount();
    await api.loadModes('thread-1');
    api.reset();
    expect(api.state.value).toBeNull();
    expect(api.hasModes.value).toBe(false);
    scope.stop();
  });
});
