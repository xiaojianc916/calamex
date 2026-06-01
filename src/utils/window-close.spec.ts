import { afterEach, describe, expect, it } from 'vitest';
import {
  allowNextProgrammaticWindowClose,
  clearProgrammaticWindowCloseAllowance,
  consumeProgrammaticWindowCloseAllowance,
} from '@/utils/window-close';

const FLAG = '__SH_EDITOR_ALLOW_WINDOW_CLOSE__';

describe('window-close 程序化关闭授权', () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[FLAG];
  });

  it('默认未授权时 consume 返回 false', () => {
    expect(consumeProgrammaticWindowCloseAllowance()).toBe(false);
  });

  it('授权后仅可消费一次（一次性）', () => {
    allowNextProgrammaticWindowClose();
    expect(consumeProgrammaticWindowCloseAllowance()).toBe(true);
    expect(consumeProgrammaticWindowCloseAllowance()).toBe(false);
  });

  it('clear 可撤销已授予的关闭许可', () => {
    allowNextProgrammaticWindowClose();
    clearProgrammaticWindowCloseAllowance();
    expect(consumeProgrammaticWindowCloseAllowance()).toBe(false);
  });
});
