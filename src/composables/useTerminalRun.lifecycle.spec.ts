import { describe, expect, it } from 'vitest';
import { shouldKeepTerminalRunScopeAlive } from '@/composables/useTerminalRun';

describe('terminal run lifecycle', () => {
  it('运行中组件卸载时应保留运行作用域', () => {
    expect(shouldKeepTerminalRunScopeAlive(true, null)).toBe(true);
  });

  it('存在当前 runId 时应保留运行作用域', () => {
    expect(shouldKeepTerminalRunScopeAlive(false, 'run-1')).toBe(true);
  });

  it('无运行且无 runId 时允许正常释放作用域', () => {
    expect(shouldKeepTerminalRunScopeAlive(false, null)).toBe(false);
    expect(shouldKeepTerminalRunScopeAlive(false, '   ')).toBe(false);
  });
});
