import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import App from '@/app/App.vue';
import { runtimeErrorState } from '@/utils/platform/runtime-diagnostics';

// 首帧交接埋点:保留其余真实导出,仅拦截本用例断言的两个函数。
const markStartupMock = vi.hoisted(() => vi.fn());
const reportStartupTimingsMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/startup-profiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/startup-profiler')>();
  return {
    ...actual,
    markStartup: markStartupMock,
    reportStartupTimings: reportStartupTimingsMock,
  };
});

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

// 工作台现由 App.vue 直接挂载(不再经 router-view);桩组件用于断言渲染与 ready 事件接线。
vi.mock('@/app/ShellWorkbenchView.vue', () => ({
  default: {
    name: 'ShellWorkbenchViewStub',
    emits: ['ready'],
    template: '<div data-testid="shell-workbench-view"></div>',
  },
}));

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
    markStartupMock.mockClear();
    reportStartupTimingsMock.mockClear();
  });

  afterEach(() => {
    runtimeErrorState.value = null;
    vi.restoreAllMocks();
    delete window.__SH_WINDOW_LABEL__;
  });

  it('直接挂载工作台与全局宿主组件', async () => {
    const wrapper = mount(App);

    await flushUi();

    expect(wrapper.find('[data-testid="app-dialog-host-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="browser-context-menu-host-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="shell-workbench-view"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it('工作台首帧 ready 后上报启动埋点', async () => {
    const wrapper = mount(App);

    wrapper.getComponent({ name: 'ShellWorkbenchViewStub' }).vm.$emit('ready');
    await flushUi();

    expect(markStartupMock).toHaveBeenCalledWith('workbench-ready-event');
    expect(reportStartupTimingsMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });
});
