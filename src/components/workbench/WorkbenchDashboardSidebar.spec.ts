import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { IEditorDocument } from '@/types/editor';

vi.mock('@/components/ui/tooltip', () => ({
  AppTooltip: {
    name: 'AppTooltip',
    props: ['content', 'side'],
    template: '<span><slot /></span>',
  },
}));

import WorkbenchDashboardSidebar from './WorkbenchDashboardSidebar.vue';

const documentFixture: IEditorDocument = {
  id: 'doc-1',
  path: 'D:/repo/demo.sh',
  name: 'demo.sh',
  kind: 'text',
  content: 'echo hello',
  encoding: 'utf-8',
  savedContent: 'echo hello',
  savedEncoding: 'utf-8',
  isDirty: false,
  lineCount: 1,
  charCount: 10,
};

const mountSidebar = () => {
  return mount(WorkbenchDashboardSidebar, {
    props: {
      activeView: 'explorer',
      isAiMode: false,
      document: documentFixture,
      isDesktopRuntime: true,
      workspaceRootPath: 'D:/repo',
      preloadedWorkspaceRoot: null,
      startupExplorerExpandedPaths: [],
      startupExplorerSelectedPath: null,
      canRun: true,
      isRunning: false,
      hasRunArtifacts: false,
      activeRun: null,
      runHistory: [],
      commandTemplates: [],
      executor: 'wsl',
    },
    global: {
      stubs: {
        AppSidebar: true,
      },
    },
  });
};

describe('WorkbenchDashboardSidebar', () => {
  it('点击顶部软件图标时会发出主界面切换事件', async () => {
    const wrapper = mountSidebar();

    await wrapper.get('.workbench-dashboard-sidebar__brand-button').trigger('click');

    expect(wrapper.emitted('toggle-primary-mode')).toHaveLength(1);
  });

  it('会根据当前主界面模式更新软件图标提示文案', async () => {
    const wrapper = mountSidebar();

    expect(wrapper.get('.workbench-dashboard-sidebar__brand-button').attributes('title')).toBe(
      '切换到 AI 界面',
    );

    await wrapper.setProps({ isAiMode: true });

    expect(wrapper.get('.workbench-dashboard-sidebar__brand-button').attributes('title')).toBe(
      '切换到编辑区',
    );
  });

  it('只展开当前侧栏按钮的文字标签', async () => {
    const wrapper = mountSidebar();
    const initialButtons = wrapper.findAll('.workbench-dashboard-sidebar__toolbar-button');

    expect(wrapper.find('.workbench-dashboard-sidebar__toolbar-indicator').exists()).toBe(false);
    expect(initialButtons).toHaveLength(5);
    expect(initialButtons[0]?.classes()).toContain('is-active');
    expect(initialButtons[0]?.text()).toContain('文件');
    expect(initialButtons[1]?.classes()).not.toContain('is-active');
    expect(initialButtons[1]?.find('.workbench-dashboard-sidebar__toolbar-label').text()).toBe(
      '搜索',
    );

    await wrapper.setProps({ activeView: 'source-control' });

    const updatedButtons = wrapper.findAll('.workbench-dashboard-sidebar__toolbar-button');

    expect(updatedButtons[0]?.classes()).not.toContain('is-active');
    expect(updatedButtons[2]?.classes()).toContain('is-active');
    expect(updatedButtons[2]?.text()).toContain('Git');
  });

  it('会根据页签顺序标记面板切换方向', async () => {
    const wrapper = mountSidebar();
    const panelHost = wrapper.get('.workbench-dashboard-sidebar__panel-host');

    expect(panelHost.attributes('data-switch-direction')).toBe('none');

    await wrapper.setProps({ activeView: 'run' });
    expect(panelHost.attributes('data-switch-direction')).toBe('forward');

    await wrapper.setProps({ activeView: 'search' });
    expect(panelHost.attributes('data-switch-direction')).toBe('backward');
  });
});
