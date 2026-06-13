import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '@/app/App.vue';
import { runtimeErrorState } from '@/utils/runtime-diagnostics';

const applyWindowStageMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('@/services/ipc/window.service', () => ({
  applyWindowStage: applyWindowStageMock,
}));

vi.mock('@/components/common/AppDialogHost.vue', () => ({
  default: {
    name: 'AppDialogHostStub',
    template: '<div data-testid="app-dialog-host-stub"></div>',
  },
}));

vi.mock('@/components/common/BrowserContextMenuHost.vue', () => ({
  default: {
    name: 'BrowserContextMenuHostStub',
    template: '<div data-testid="browser-context-menu-host-stub"></div>',
  },
}));

const HomeView = defineComponent({
  name: 'HomeViewStub',
  template: '<div data-testid="home-view">home</div>',
});

const createTestRouter = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/home',
        name: 'home',
        component: HomeView,
      },
    ],
  });

const flushUi = async (): Promise<void> => {
  await nextTick();
  await flushPromises();
  await nextTick();
};

describe('App startup handoff', () => {
  beforeEach(() => {
    runtimeErrorState.value = null;
    document.documentElement.dataset.theme = 'dark';
    window.__SH_WINDOW_LABEL__ = 'main';
    (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(),
    };
    applyWindowStageMock.mockClear();
  });

  afterEach(() => {
    runtimeErrorState.value = null;
    vi.restoreAllMocks();
    delete window.__SH_WINDOW_LABEL__;
    delete (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  });

  it('渲染当前路由与全局宿主组件', async () => {
    const router = createTestRouter();
    await router.push('/home');
    await router.isReady();

    const wrapper = mount(App, {
      global: {
        plugins: [router],
      },
    });

    await flushUi();

    expect(wrapper.find('[data-testid="app-dialog-host-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="browser-context-menu-host-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it('工作台首帧 ready 后同步主窗口阶段', async () => {
    const router = createTestRouter();
    await router.push('/home');
    await router.isReady();

    const wrapper = mount(App, {
      global: {
        plugins: [router],
      },
    });

    wrapper.findComponent(HomeView).vm.$emit('ready');
    await flushUi();

    expect(applyWindowStageMock).toHaveBeenCalledWith({ stage: 'main' });

    wrapper.unmount();
  });
});
