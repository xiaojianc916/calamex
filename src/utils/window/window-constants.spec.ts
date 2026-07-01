import { describe, expect, it } from 'vitest';
import { MAIN_WINDOW_LABEL } from '@/utils/window/app-window';

describe('窗口相关常量契约', () => {
  it('主窗口标签固定为 main', () => {
    expect(MAIN_WINDOW_LABEL).toBe('main');
  });
});
