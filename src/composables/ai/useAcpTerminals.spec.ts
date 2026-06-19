import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';

import { type IUseAcpTerminalsReturn, useAcpTerminals } from './useAcpTerminals';

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpTerminalsReturn;
  scope.run(() => {
    api = useAcpTerminals();
  });
  return { api: api!, scope };
};

describe('useAcpTerminals', () => {
  it('初始为空', () => {
    const { api, scope } = mount();
    expect(api.hasTerminals.value).toBe(false);
    expect(api.resolveTerminal('t1')).toBeUndefined();
    scope.stop();
  });

  it('applyTerminalSnapshot 归一并按 id 注册', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: '运行中', exitStatus: null });
    expect(api.hasTerminals.value).toBe(true);
    expect(api.resolveTerminal('t1')).toEqual({ output: '运行中', streaming: true });
    scope.stop();
  });

  it('同 id 更新覆盖（流式增量）', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a', exitStatus: null });
    api.applyTerminalSnapshot('t1', { output: 'ab', exitStatus: { exitCode: 0, signal: null } });
    expect(api.resolveTerminal('t1')).toEqual({ output: 'ab', streaming: false });
    scope.stop();
  });

  it('无效负载 no-op：保留既有快照', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a', exitStatus: null });
    api.applyTerminalSnapshot('t1', { output: 123 });
    expect(api.resolveTerminal('t1')).toEqual({ output: 'a', streaming: true });
    scope.stop();
  });

  it('空 terminalId no-op', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('', { output: 'a' });
    expect(api.hasTerminals.value).toBe(false);
    scope.stop();
  });

  it('removeTerminal 移除', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a' });
    api.removeTerminal('t1');
    expect(api.resolveTerminal('t1')).toBeUndefined();
    scope.stop();
  });

  it('reset 清空', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a' });
    api.reset();
    expect(api.hasTerminals.value).toBe(false);
    scope.stop();
  });
});
