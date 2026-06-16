import { describe, expect, it } from 'vitest';
import { MAIN_WINDOW_LABEL } from '@/utils/window/app-window';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';

describe('窗口相关常量契约', () => {
  it('主窗口标签固定为 main', () => {
    expect(MAIN_WINDOW_LABEL).toBe('main');
  });

  it('窗口缩放事件名保持稳定且互不相同', () => {
    expect(SHELL_WINDOW_RESIZE_START_EVENT).toBe('shell-window-resize-start');
    expect(SHELL_WINDOW_RESIZE_END_EVENT).toBe('shell-window-resize-end');
    expect(SHELL_WINDOW_RESIZE_SETTLED_EVENT).toBe('shell-window-resize-settled');
    const unique = new Set([
      SHELL_WINDOW_RESIZE_START_EVENT,
      SHELL_WINDOW_RESIZE_END_EVENT,
      SHELL_WINDOW_RESIZE_SETTLED_EVENT,
    ]);
    expect(unique.size).toBe(3);
  });
});
