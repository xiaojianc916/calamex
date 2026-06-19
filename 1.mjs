// 3.mjs —— 修复最后 1 个失败用例：src/components/workbench/AppSidebar.spec.ts
// 用法（仓库根目录 D:\com.xiaojianc\my_desktop_app 下）：
//   node 3.mjs && pnpm format && pnpm test
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REL = 'src/components/workbench/AppSidebar.spec.ts';

if (!existsSync(REL)) {
  console.error('✗ 找不到文件: ' + REL + '（请在仓库根目录运行）');
  process.exit(1);
}

// 目标文件完整内容（用 \n 作为内部换行，稍后按原文件 EOL 落盘）
const raw = `
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { TooltipProvider } from 'reka-ui';
import { defineComponent, h } from 'vue';
import { describe, expect, it } from 'vitest';
import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';
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

const populatedWorkspaceRoot: IWorkspaceDirectoryPayload = {
  rootPath: 'D:/repo',
  rootName: 'repo',
  entries: [
    {
      path: 'D:/repo/demo.c',
      name: 'demo.c',
      kind: 'file',
      hasChildren: false,
    },
  ],
};

const baseStubs = {
  SourceControlPanel: true,
  DeferredSearchSidebarPanel: true,
  DeferredRunSidebarPanel: true,
  DeferredSshSidebarPanel: true,
  DeferredLinearContextMenu: true,
};

const buildSidebarProps = (
  document: IEditorDocument,
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload,
) => ({
  document,
  view: 'explorer' as const,
  isDesktopRuntime: true,
  workspaceRootPath: 'D:/repo',
  preloadedWorkspaceRoot,
  startupExplorerExpandedPaths: [] as string[],
  startupExplorerSelectedPath: null,
  canRun: true,
  isRunning: false,
  hasRunArtifacts: false,
  activeRun: null,
  runHistory: [],
  commandTemplates: [],
  executor: 'wsl' as const,
});

// reka-ui 的 Tooltip 需要 TooltipProvider 注入上下文，
// 因此所有挂载都包一层 TooltipProvider，避免 TooltipProviderContext 注入缺失报错。
const mountSidebar = (
  props: ReturnType<typeof buildSidebarProps>,
  stubs: Record<string, unknown> = baseStubs,
) =>
  mount(
    defineComponent({
      setup() {
        return () => h(TooltipProvider, null, { default: () => h(AppSidebar, props) });
      },
    }),
    {
      global: {
        plugins: [createPinia()],
        stubs,
      },
    },
  );

describe('AppSidebar', () => {
  it('空工作区时显示 Empty 装饰并允许打开文件夹', async () => {
    const wrapper = mountSidebar(buildSidebarProps(documentFixture, emptyWorkspaceRoot));

    await flushPromises();

    // 空工作区由真实的 WorkspaceTreeNode 渲染“空文件夹”占位；
    // 预加载了工作区根时不会进入 .explorer-empty-action 的空状态分支。
    expect(wrapper.text()).toContain('空文件夹');
    expect(wrapper.find('.explorer-empty-action').exists()).toBe(false);
  });

  it('右键未选中文件时会保留临时高亮，菜单关闭后清除', async () => {
    const wrapper = mountSidebar(buildSidebarProps(documentFixture, populatedWorkspaceRoot));

    await flushPromises();

    const row = wrapper
      .findAll('.explorer-tree-row')
      .find((candidate) => candidate.text().includes('demo.c'));

    expect(row).toBeDefined();

    await row!.trigger('contextmenu', {
      clientX: 80,
      clientY: 120,
    });
    await flushPromises();

    expect(row!.classes()).toContain('is-context-target');
    expect(row!.classes()).not.toContain('is-active');

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await flushPromises();

    expect(row!.classes()).not.toContain('is-context-target');
  });

  it('右键当前已选中文件时不叠加临时高亮类', async () => {
    const wrapper = mountSidebar(
      buildSidebarProps(
        {
          ...documentFixture,
          path: 'D:/repo/demo.c',
          name: 'demo.c',
        },
        populatedWorkspaceRoot,
      ),
    );

    await flushPromises();

    const row = wrapper
      .findAll('.explorer-tree-row')
      .find((candidate) => candidate.text().includes('demo.c'));

    expect(row).toBeDefined();
    expect(row!.classes()).toContain('is-active');

    await row!.trigger('contextmenu', {
      clientX: 80,
      clientY: 120,
    });
    await flushPromises();

    expect(row!.classes()).toContain('is-active');
    expect(row!.classes()).not.toContain('is-context-target');
  });
});
`;

// 归一化脚本自身可能带的 CRLF，再按原文件 EOL 落盘
const content = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').slice(1);
const existing = readFileSync(REL, 'utf8');
const eol = existing.includes('\r\n') ? '\r\n' : '\n';
const out = content.replace(/\n/g, eol);
writeFileSync(REL, out, 'utf8');
console.log('✓ rewrote ' + REL + ' (eol=' + (eol === '\r\n' ? 'CRLF' : 'LF') + ')');