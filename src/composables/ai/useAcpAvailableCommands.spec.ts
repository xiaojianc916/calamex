import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';

import {
  type IUseAcpAvailableCommandsReturn,
  useAcpAvailableCommands,
} from './useAcpAvailableCommands';

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpAvailableCommandsReturn;
  scope.run(() => {
    api = useAcpAvailableCommands();
  });
  return { api: api!, scope };
};

describe('useAcpAvailableCommands', () => {
  it('初始为空', () => {
    const { api, scope } = mount();
    expect(api.state.value).toBeNull();
    expect(api.hasCommands.value).toBe(false);
    expect(api.commands.value).toEqual([]);
    scope.stop();
  });

  it('applyCommandsUpdate 归一并填充 VM', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([
      { name: 'plan', description: '生成计划' },
      { name: 'test', description: '运行测试', input: { hint: '范围' } },
    ]);
    expect(api.hasCommands.value).toBe(true);
    expect(api.commands.value).toEqual([
      { name: 'plan', description: '生成计划' },
      { name: 'test', description: '运行测试', inputHint: '范围' },
    ]);
    scope.stop();
  });

  it('整份替换：后一次更新覆盖前一次', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([{ name: 'a', description: 'd' }]);
    api.applyCommandsUpdate([{ name: 'b', description: 'd2' }]);
    expect(api.commands.value).toEqual([{ name: 'b', description: 'd2' }]);
    scope.stop();
  });

  it('空 / 无效更新清空 VM', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([{ name: 'a', description: 'd' }]);
    api.applyCommandsUpdate([]);
    expect(api.state.value).toBeNull();
    expect(api.hasCommands.value).toBe(false);
    scope.stop();
  });

  it('reset 清空 VM', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([{ name: 'a', description: 'd' }]);
    api.reset();
    expect(api.state.value).toBeNull();
    scope.stop();
  });
});
