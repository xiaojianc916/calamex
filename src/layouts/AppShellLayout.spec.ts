import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppShellLayout from '@/layouts/AppShellLayout.vue';

const windowApiMock = vi.hoisted(() => ({
  isMaximized: vi.fn(() => Promise.resolve(false)),
  minimize: vi.fn(() => Promise.resolve()),
  onResized: vi.fn(() => Promise.resolve(() => undefined)),
  startDragging: vi.fn(() => Promise.resolve()),
  startResizeDragging: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApiMock,
}));

describe('AppShellLayout window interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('desktop 模式下点击顶部拖动区域会启动窗口拖动', async () => {
    const wrapper = mount(AppShellLayout, {
      props: {
        isDesktopRuntime: true,
      },
      slots: {
        default: '<div data-testid="content">content</div>',
      },
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    await wrapper.find('.app-window-drag-region').trigger('mousedown', { button: 0 });
    await flushPromises();

    expect(windowApiMock.startDragging).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it('非主键点击顶部拖动区域不会启动窗口拖动', async () => {
    const wrapper = mount(AppShellLayout, {
      props: {
        isDesktopRuntime: true,
      },
      slots: {
        default: '<div data-testid="content">content</div>',
      },
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    await wrapper.find('.app-window-drag-region').trigger('mousedown', { button: 2 });
    await flushPromises();

    expect(windowApiMock.startDragging).not.toHaveBeenCalled();

    wrapper.unmount();
  });
});
