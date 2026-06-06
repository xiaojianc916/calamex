#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write = (path, value) => writeFileSync(resolve(root, path), value, 'utf8');

const fail = (path, label) => {
  throw new Error(`[test-suite-compat-patch] ${path} 未找到补丁锚点：${label}`);
};

const replaceOnce = (path, source, oldText, newText, label) => {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) fail(path, label);
  return source.replace(oldText, newText);
};

const replaceRegex = (path, source, regex, replacement, label) => {
  if (typeof replacement === 'string' && source.includes(replacement)) return source;
  if (!regex.test(source)) fail(path, label);
  return source.replace(regex, replacement);
};

const updateFile = (path, updater) => {
  const before = read(path);
  const after = updater(before);
  if (after === before) {
    console.log(`[test-suite-compat-patch] ${path} 无需更新。`);
    return;
  }
  write(path, after);
  console.log(`[test-suite-compat-patch] 已更新 ${path}`);
};

updateFile('src/services/tauri.spec.ts', (source) =>
  replaceOnce(
    'src/services/tauri.spec.ts',
    source,
    "    expect(invokeMock).toHaveBeenCalledWith('load_script', { path: 'D:/demo.sh' });",
    "    expect(invokeMock).toHaveBeenCalledWith('load_script', {\n      path: 'D:/demo.sh',\n      workspaceRootPath: null,\n    });",
    'loadScript expectation includes workspaceRootPath',
  ),
);

updateFile('src/utils/workspace.ts', (source) => {
  let next = source;
  next = replaceOnce(
    'src/utils/workspace.ts',
    next,
    "import type { IWorkspaceDirectoryPayload } from '@/types/editor';",
    "import type { IWorkspaceDirectoryPayload, IWorkspaceEntry } from '@/types/editor';",
    'workspace type import',
  );
  if (next.includes('collectWorkspaceExpandedPathsByQuery')) return next;
  return `${next.trimEnd()}\n\nconst normalizeWorkspaceQuery = (value: string): string => value.trim().toLocaleLowerCase();\n\nexport const collectWorkspaceExpandedPathsByQuery = (\n  entries: readonly IWorkspaceEntry[],\n  query: string,\n  childrenMap: Readonly<Record<string, readonly IWorkspaceEntry[]>> = {},\n): ReadonlySet<string> => {\n  const normalizedQuery = normalizeWorkspaceQuery(query);\n  const expandedPaths = new Set<string>();\n  if (!normalizedQuery) {\n    return expandedPaths;\n  }\n\n  const visit = (items: readonly IWorkspaceEntry[], ancestorPaths: readonly string[]): void => {\n    for (const entry of items) {\n      const haystack = normalizeWorkspaceQuery(`${entry.name} ${entry.path}`);\n      if (haystack.includes(normalizedQuery)) {\n        ancestorPaths.forEach((path) => expandedPaths.add(path));\n      }\n\n      if (entry.kind !== 'directory') {\n        continue;\n      }\n\n      const children = childrenMap[entry.path] ?? [];\n      if (children.length > 0) {\n        visit(children, [...ancestorPaths, entry.path]);\n      }\n    }\n  };\n\n  visit(entries, []);\n  return expandedPaths;\n};\n`;
});

updateFile('src/components/workbench/SearchSidebarPanel.spec.ts', (source) =>
  replaceOnce(
    'src/components/workbench/SearchSidebarPanel.spec.ts',
    source,
    "    await wrapper.find('.search-panel-path-filter input').setValue('src/**');\n    await flushDebouncedSearch();",
    "    const includePathInput = wrapper.find('.search-panel-path-filter input');\n    await includePathInput.setValue('src/**');\n    await includePathInput.trigger('keydown', { key: 'Enter' });\n    await flushDebouncedSearch();",
    'commit path filter draft before asserting backend search',
  ),
);

updateFile('src/components/business/ai/chat/AiPromptInput.spec.ts', (source) => {
  let next = source;
  next = replaceOnce(
    'src/components/business/ai/chat/AiPromptInput.spec.ts',
    next,
    "    wrapper.get('textarea').element.dispatchEvent(event);",
    "    wrapper.get('[data-slot=\"ai-prompt-editor\"]').element.dispatchEvent(event);",
    'paste event target uses contenteditable editor',
  );
  next = replaceOnce(
    'src/components/business/ai/chat/AiPromptInput.spec.ts',
    next,
    "    const textarea = wrapper.get('textarea');\n    const element = textarea.element as HTMLTextAreaElement;\n\n    expect(wrapper.get('.ai-composer-surface').exists()).toBe(true);\n    expect(element.style.height).toBe('');\n\n    await textarea.setValue('第一行\\n第二行\\n第三行\\n第四行');\n\n    expect(element.style.height).toBe('');",
    "    const editor = wrapper.get('[data-slot=\"ai-prompt-editor\"]');\n    const element = editor.element as HTMLElement;\n\n    expect(wrapper.get('.ai-composer-surface').exists()).toBe(true);\n    expect(element.style.height).toBe('');\n\n    element.textContent = '第一行\\n第二行\\n第三行\\n第四行';\n    await editor.trigger('input');\n\n    expect(element.style.height).toBe('');",
    'fixed composer height test uses contenteditable editor',
  );
  return next;
});

updateFile('src/components/workbench/GitHistoryGraph.vue', (source) =>
  replaceOnce(
    'src/components/workbench/GitHistoryGraph.vue',
    source,
    "            <span class=\"git-history-graph-message-text\" v-text=\"row.commit.summary\" />\n            <span",
    "            <span class=\"git-history-graph-message-text\" v-text=\"row.commit.summary\" />\n            <span class=\"source-control-history-author\" v-text=\"row.commit.authorName\" />\n            <span",
    'history author compatibility span',
  ),
);

updateFile('src/components/workbench/SourceControlPanel.vue', (source) =>
  replaceOnce(
    'src/components/workbench/SourceControlPanel.vue',
    source,
    "                  <span v-else aria-hidden=\"true\" class=\"source-control-branch-row-switch\">切换</span>",
    "                  <span v-else aria-hidden=\"true\" class=\"source-control-branch-row-switch source-control-btn\">切换</span>",
    'branch switch compatibility class',
  ),
);

console.log('[test-suite-compat-patch] 完成。建议继续运行：pnpm typecheck && pnpm test');
