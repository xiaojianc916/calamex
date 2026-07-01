import { useResizeObserver } from '@vueuse/core';
import { onScopeDispose } from 'vue';
import { createMutableDisposable } from '@/utils/core/disposable';
import { requestDisposableTimeout } from '@/utils/platform/dom-lifecycle';

/**
 * 窗口 resize 期间的全局 `is-resizing` 态：由浏览器原生 ResizeObserver 直接驱动，
 * 不再自制 START/END 会话。
 *
 * 历史写法（已移除）：监听 Tauri onResized + 自定义 START/END DOM 事件（由
 * AppShellLayout.vue 在 resize 手柄 mousedown 时手动派发），叠加 rAF 帧泵与
 * 两级看门狗（800ms 起始超时 + 12s 帧泵硬上限）防止“派发了 START 却收不到
 * 配对的 END”（原生 startResizeDragging 接管后鼠标释放发生在 OS 层，webview
 * 经常收不到 mouseup）。这套复杂度的根源是“自制会话”本身：只要还需要手动
 * 配对 START/END，就永远可能出现丢配对的边界情况，看门狗只能缓解、无法根除。
 *
 * 新写法用 ResizeObserver 观察 <html> 的渲染尺寸：无论尺寸变化来自手柄拖拽、
 * Tauri 原生 resize、OS 贴边吸附还是双击标题栏最大化，只要渲染尺寸真的变了
 * 就会收到回调——不存在“会话”概念，也就不存在“配对失败”。收尾只需要一个
 * 去抖计时器：每次回调重置计时器，停止收到新回调超过 RESIZE_SETTLE_DELAY_MS
 * 后判定已定稳。
 */
const RESIZE_SETTLE_DELAY_MS = 160;

export const useWindowResizeState = (): void => {
  const html = document.documentElement;
  const settleTimer = createMutableDisposable();

  const scheduleSettle = (): void => {
    settleTimer.set(
      requestDisposableTimeout(() => {
        settleTimer.clear();
        html.classList.remove('is-resizing');
      }, RESIZE_SETTLE_DELAY_MS),
    );
  };

  useResizeObserver(html, () => {
    html.classList.add('is-resizing');
    scheduleSettle();
  });

  onScopeDispose(() => {
    settleTimer.dispose();
    html.classList.remove('is-resizing');
  });
};
