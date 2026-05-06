import type { IEditorDocument } from '@/types/editor';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
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

        expect(wrapper.get('.workbench-dashboard-sidebar__brand-button').attributes('title')).toBe('切换到 AI 界面');

        await wrapper.setProps({ isAiMode: true });

        expect(wrapper.get('.workbench-dashboard-sidebar__brand-button').attributes('title')).toBe('切换到编辑区');
    });
});