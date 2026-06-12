#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write = (path, text) => writeFileSync(resolve(root, path), text, 'utf8');

const replaceOnce = (path, oldText, newText, label) => {
  const text = read(path);
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    throw new Error(`[${path}] ${label}: expected 1 match, got ${count}`);
  }
  write(path, text.replace(oldText, newText));
};

const replaceRegexOnce = (path, pattern, replacement, label) => {
  const text = read(path);
  const matches = text.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`[${path}] ${label}: expected 1 regex match`);
  }
  write(path, text.replace(pattern, replacement));
};

// 1) 修 SearchSidebarPanel.lifecycle.spec.ts 的 OXC parse error。
// 原因：单引号字符串里写 Vue template，再套 $emit('xxx')，转义在 OXC 下被解析成坏字符串。
// 方案：把 template 改成反引号模板字符串，彻底消除转义歧义。
{
  const path = 'src/components/workbench/SearchSidebarPanel.lifecycle.spec.ts';

  replaceRegexOnce(
    path,
    /template:\s*\n\s*['"]<input :value="modelValue" @input="\$emit\((?:\\\\)?'update:modelValue(?:\\\\)?', \$event\.target\.value\)" @keydown\.enter="\$emit\((?:\\\\)?'keydown(?:\\\\)?', \$event\)" \/>['"],/,
    `template: \`
      <input
        :value="modelValue"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        @keydown.enter="$emit('keydown', $event)"
      />
    \`,`,
    'fix mocked Input template quoting',
  );
}

// 2) 修 AiWebPreviewSidebar.spec.ts 的过期 iframe 断言。
// 当前实现使用原生 webview 占位 host，不再在 DOM 里渲染 iframe。
// 这里保留功能验证：提交地址会 emit url-change，并且 preview body host 存在。
{
  const path = 'src/components/business/ai/shell/AiWebPreviewSidebar.spec.ts';

  replaceOnce(
    path,
    `    expect(wrapper.emitted('url-change')?.[0]).toEqual(['https://example.com']);
    expect(wrapper.get('iframe').attributes('src')).toBe('https://example.com');`,
    `    expect(wrapper.emitted('url-change')?.[0]).toEqual(['https://example.com']);
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.get('.ai-web-preview-body__host').exists()).toBe(true);
    expect(wrapper.text()).toContain('URL changed to: https://example.com');`,
    'update native webview preview assertion',
  );
}

console.log('Fixed current test failures:');
console.log(' - src/components/workbench/SearchSidebarPanel.lifecycle.spec.ts');
console.log(' - src/components/business/ai/shell/AiWebPreviewSidebar.spec.ts');
console.log('');
console.log('Next:');
console.log('  pnpm test');
console.log('');
console.log('Rollback:');
console.log(
  '  git checkout -- src/components/workbench/SearchSidebarPanel.lifecycle.spec.ts src/components/business/ai/shell/AiWebPreviewSidebar.spec.ts',
);