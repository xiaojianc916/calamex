// 2.mjs —— 仓库根目录: node 2.mjs ;之后 pnpm format && pnpm test
// CRLF 安全(匹配前归一化为 LF,写回保留原行尾)
import { readFileSync, writeFileSync } from 'node:fs';

let failed = false;
const detectEol = (raw) => (raw.includes('\r\n') ? '\r\n' : '\n');
const toLf = (raw) => raw.replace(/\r\n/g, '\n');

function patch(rel, edits) {
  let raw;
  try { raw = readFileSync(rel, 'utf8'); }
  catch { console.error('✗ 读不到文件:', rel); failed = true; return; }
  const eol = detectEol(raw);
  let work = toLf(raw);
  const orig = work;
  for (const [find, replace] of edits) {
    const n = work.split(find).length - 1;
    if (n !== 1) {
      console.error(`✗ ${rel}: 锚点命中 ${n} 次(应为 1),跳过本文件。`);
      failed = true;
      return;
    }
    work = work.replace(find, () => replace);
  }
  if (work !== orig) {
    writeFileSync(rel, eol === '\r\n' ? work.replace(/\n/g, '\r\n') : work);
    console.log(`✓ patched ${rel} (EOL=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
  } else {
    console.log('· 无变化', rel);
  }
}

function rewrite(rel, content) {
  let eol = '\n';
  try { eol = detectEol(readFileSync(rel, 'utf8')); } catch {}
  writeFileSync(rel, eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content);
  console.log(`✓ rewrote ${rel} (EOL=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
}

// ── ① shadowCompare.ts:补回 complete / compare / listComparisons ──
patch('src/services/terminal/shadowCompare.ts', [
  // a) 在 return 之前加 compareRun 辅助函数
  [
    [
      '    runs.set(runId, created);',
      '    return created;',
      '  };',
      '',
      '  return {',
      '    runs,',
    ].join('\n'),
    [
      '    runs.set(runId, created);',
      '    return created;',
      '  };',
      '',
      '  const compareRun = (runId: string) => {',
      '    const run = ensureRun(runId);',
      '    const encoder = new TextEncoder();',
      '    const legacyDuration =',
      '      run.legacy.startedAt === null || run.legacy.finishedAt === null',
      '        ? null',
      '        : run.legacy.finishedAt - run.legacy.startedAt;',
      '    const shadowDuration =',
      '      run.shadow.startedAt === null || run.shadow.finishedAt === null',
      '        ? null',
      '        : run.shadow.finishedAt - run.shadow.startedAt;',
      '    return {',
      '      runId,',
      '      outputEqual: run.legacy.output === run.shadow.output,',
      '      byteDiff:',
      '        encoder.encode(run.shadow.output).length - encoder.encode(run.legacy.output).length,',
      '      durationDeltaMs:',
      '        legacyDuration === null || shadowDuration === null ? 0 : shadowDuration - legacyDuration,',
      '      stateSequenceEqual:',
      '        run.legacy.states.length === run.shadow.states.length &&',
      '        run.legacy.states.every((state, index) => state === run.shadow.states[index]),',
      '    };',
      '  };',
      '',
      '  return {',
      '    runs,',
    ].join('\n'),
  ],
  // b) 在 reset 之前加三个方法
  [
    [
      '    reset(): void {',
      '      runs.clear();',
      '    },',
    ].join('\n'),
    [
      '    complete(runId: string, channel: TTerminalShadowCompareChannel, finishedAt: number): void {',
      '      ensureRun(runId)[channel].finishedAt = finishedAt;',
      '    },',
      '',
      '    compare(runId: string) {',
      '      return compareRun(runId);',
      '    },',
      '',
      '    listComparisons() {',
      '      return Array.from(runs.keys()).map((runId) => compareRun(runId));',
      '    },',
      '',
      '    reset(): void {',
      '      runs.clear();',
      '    },',
    ].join('\n'),
  ],
]);

// ── ② AppSidebar.spec.ts:用 TooltipProvider 包裹挂载(纯测试夹具)──
rewrite(
  'src/components/workbench/AppSidebar.spec.ts',
  [
    `import { flushPromises, mount } from '@vue/test-utils';`,
    `import { createPinia } from 'pinia';`,
    `import { describe, expect, it } from 'vitest';`,
    `import { defineComponent, h } from 'vue';`,
    `import { TooltipProvider } from 'reka-ui';`,
    `import type { IEditorDocument, IWorkspaceDirectoryPayload } from '@/types/editor';`,
    `import AppSidebar from './AppSidebar.vue';`,
    ``,
    `const documentFixture = {`,
    `  id: 'doc-1',`,
    `  path: null,`,
    `  name: 'untitled.sh',`,
    `  kind: 'text',`,
    `  content: '',`,
    `  encoding: 'utf-8',`,
    `  savedContent: '',`,
    `  savedEncoding: 'utf-8',`,
    `  isDirty: false,`,
    `  lineCount: 1,`,
    `  charCount: 0,`,
    `};`,
    ``,
    `const emptyWorkspaceRoot: IWorkspaceDirectoryPayload = {`,
    `  rootPath: 'D:/repo',`,
    `  rootName: 'repo',`,
    `  entries: [],`,
    `};`,
    ``,
    `const populatedWorkspaceRoot: IWorkspaceDirectoryPayload = {`,
    `  rootPath: 'D:/repo',`,
    `  rootName: 'repo',`,
    `  entries: [`,
    `    {`,
    `      path: 'D:/repo/demo.c',`,
    `      name: 'demo.c',`,
    `      kind: 'file',`,
    `      hasChildren: false,`,
    `    },`,
    `  ],`,
    `};`,
    ``,
    `const baseStubs = {`,
    `  SourceControlPanel: true,`,
    `  DeferredSearchSidebarPanel: true,`,
    `  DeferredRunSidebarPanel: true,`,
    `  DeferredSshSidebarPanel: true,`,
    `  DeferredLinearContextMenu: true,`,
    `};`,
    ``,
    `// reka-ui 的 Tooltip 基元需要祖先 TooltipProvider;单测用一个 provider 包裹被测组件。`,
    `const mountInProvider = (`,
    `  renderChild: () => ReturnType<typeof h>,`,
    `  stubs: Record<string, unknown>,`,
    `) =>`,
    `  mount(`,
    `    defineComponent({`,
    `      setup() {`,
    `        return () => h(TooltipProvider, null, { default: renderChild });`,
    `      },`,
    `    }),`,
    `    {`,
    `      global: {`,
    `        plugins: [createPinia()],`,
    `        stubs,`,
    `      },`,
    `    },`,
    `  );`,
    ``,
    `const mountExplorerSidebar = (document: IEditorDocument) =>`,
    `  mountInProvider(`,
    `    () =>`,
    `      h(AppSidebar, {`,
    `        document,`,
    `        view: 'explorer',`,
    `        isDesktopRuntime: true,`,
    `        workspaceRootPath: 'D:/repo',`,
    `        preloadedWorkspaceRoot: populatedWorkspaceRoot,`,
    `        startupExplorerExpandedPaths: [],`,
    `        startupExplorerSelectedPath: null,`,
    `        canRun: true,`,
    `        isRunning: false,`,
    `        hasRunArtifacts: false,`,
    `        activeRun: null,`,
    `        runHistory: [],`,
    `        commandTemplates: [],`,
    `        executor: 'wsl',`,
    `      }),`,
    `    baseStubs,`,
    `  );`,
    ``,
    `describe('AppSidebar', () => {`,
    `  it('空工作区时显示 Empty 装饰并允许打开文件夹', async () => {`,
    `    const wrapper = mountInProvider(`,
    `      () =>`,
    `        h(AppSidebar, {`,
    `          document: documentFixture,`,
    `          view: 'explorer',`,
    `          isDesktopRuntime: true,`,
    `          workspaceRootPath: 'D:/repo',`,
    `          preloadedWorkspaceRoot: emptyWorkspaceRoot,`,
    `          startupExplorerExpandedPaths: [],`,
    `          startupExplorerSelectedPath: null,`,
    `          canRun: true,`,
    `          isRunning: false,`,
    `          hasRunArtifacts: false,`,
    `          activeRun: null,`,
    `          runHistory: [],`,
    `          commandTemplates: [],`,
    `          executor: 'wsl',`,
    `        }),`,
    `      {`,
    `        ...baseStubs,`,
    `        FileTree: true,`,
    `        WorkspaceTreeNode: true,`,
    `      },`,
    `    );`,
    ``,
    `    await flushPromises();`,
    ``,
    `    expect(wrapper.text()).toContain('空文件夹');`,
    ``,
    `    await wrapper.get('.explorer-empty-action').trigger('click');`,
    ``,
    `    expect(wrapper.findComponent(AppSidebar).emitted('open-folder')).toHaveLength(1);`,
    `  });`,
    ``,
    `  it('右键未选中文件时会保留临时高亮，菜单关闭后清除', async () => {`,
    `    const wrapper = mountExplorerSidebar(documentFixture);`,
    ``,
    `    await flushPromises();`,
    ``,
    `    const row = wrapper`,
    `      .findAll('.explorer-tree-row')`,
    `      .find((candidate) => candidate.text().includes('demo.c'));`,
    ``,
    `    expect(row).toBeDefined();`,
    ``,
    `    await row!.trigger('contextmenu', {`,
    `      clientX: 80,`,
    `      clientY: 120,`,
    `    });`,
    `    await flushPromises();`,
    ``,
    `    expect(row!.classes()).toContain('is-context-target');`,
    `    expect(row!.classes()).not.toContain('is-active');`,
    ``,
    `    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));`,
    `    await flushPromises();`,
    ``,
    `    expect(row!.classes()).not.toContain('is-context-target');`,
    `  });`,
    ``,
    `  it('右键当前已选中文件时不叠加临时高亮类', async () => {`,
    `    const wrapper = mountExplorerSidebar({`,
    `      ...documentFixture,`,
    `      path: 'D:/repo/demo.c',`,
    `      name: 'demo.c',`,
    `    });`,
    ``,
    `    await flushPromises();`,
    ``,
    `    const row = wrapper`,
    `      .findAll('.explorer-tree-row')`,
    `      .find((candidate) => candidate.text().includes('demo.c'));`,
    ``,
    `    expect(row).toBeDefined();`,
    `    expect(row!.classes()).toContain('is-active');`,
    ``,
    `    await row!.trigger('contextmenu', {`,
    `      clientX: 80,`,
    `      clientY: 120,`,
    `    });`,
    `    await flushPromises();`,
    ``,
    `    expect(row!.classes()).toContain('is-active');`,
    `    expect(row!.classes()).not.toContain('is-context-target');`,
    `  });`,
    `});`,
    ``,
  ].join('\n'),
);

if (failed) {
  console.error('\n仍有文件锚点不匹配 → 把该文件最新内容发我重新校锚点。');
  process.exitCode = 1;
} else {
  console.log('\n全部完成。接着: pnpm format && pnpm test');
}