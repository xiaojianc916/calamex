import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { describe, expect, it } from 'vitest';
import AppSidebar from './AppSidebar.vue';

const documentFixture: IEditorDocument = {
    id: 'doc-1',
    path: null,
    name: 'untitled.sh',
    kind: 'text',
    content: '',
    encoding: 'utf-8',
    savedContent: '',
    savedEncoding: 'utf-8',
    isDirty: false,
    lineCount: 1,
    charCount: 0,
};

const emptyWorkspaceRoot: IWorkspaceDirectoryPayload = {
    rootPath: 'D:/repo',
    rootName: 'repo',
    entries: [],
};

describe('AppSidebar', () => {
    it('空工作区时显示 Empty 装饰并允许打开文件夹', async () => {
        const wrapper = mount(AppSidebar, {
            props: {
                document: documentFixture,
                view: 'explorer',
                isDesktopRuntime: true,
                workspaceRootPath: 'D:/repo',
                preloadedWorkspaceRoot: emptyWorkspaceRoot,
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
                plugins: [createPinia()],
                stubs: {
                    SourceControlPanel: true,
                    DeferredSearchSidebarPanel: true,
                    DeferredRunSidebarPanel: true,
                    DeferredSshSidebarPanel: true,
                    DeferredLinearContextMenu: true,
                    FileTree: true,
                    WorkspaceTreeNode: true,
                },
            },
        });

        await flushPromises();

        expect(wrapper.text()).toContain('This folder is empty');

        await wrapper.get('.explorer-empty-action').trigger('click');

        expect(wrapper.emitted('open-folder')).toHaveLength(1);
    });
});