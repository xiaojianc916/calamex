#!/usr/bin/env node
/**
 * fix-input-submit-and-search-scroll-ux.mjs
 *
 * 修用户能感知的问题：
 *
 * 1. AiPromptInput.vue
 *    - 粘贴 plain text 后立即同步 contenteditable 到 modelValue。
 *    - submit 前主动 syncFromEditor，避免发旧值。
 *
 * 2. useSearchResultVirtualizer.ts
 *    - 搜索结果重置/切换时，把虚拟列表滚回顶部。
 *    - DOM 更新后再 measure，减少虚拟列表空白/错位。
 *
 * 用法：
 *   node fix-input-submit-and-search-scroll-ux.mjs
 *   node fix-input-submit-and-search-scroll-ux.mjs --apply
 *
 * 不生成备份文件。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');

const abs = (file) => join(root, file);

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

const read = (file) => {
  const path = abs(file);
  if (!existsSync(path)) {
    fail(`缺少文件：${file}`);
  }
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
};

const write = (file, content) => {
  if (apply) {
    writeFileSync(abs(file), content, 'utf8');
  }
};

const replaceOnce = (content, oldText, newText, label) => {
  if (content.includes(newText)) {
    console.log(`• 已存在，跳过：${label}`);
    return content;
  }

  const count = content.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}：期望匹配 1 次，实际 ${count} 次`);
  }

  console.log(`✓ ${label}`);
  return content.replace(oldText, newText);
};

const patchAiPromptInput = () => {
  const file = 'src/components/business/ai/chat/AiPromptInput.vue';
  let content = read(file);

  content = replaceOnce(
    content,
    `  if (text) {
    event.preventDefault();
    document.execCommand('insertText', false, text);
  }
};
`,
    `  if (text) {
    event.preventDefault();
    document.execCommand('insertText', false, text);
    syncFromEditor();
    updateSlashStateFromCaret();
  }
};
`,
    `${file}: 粘贴纯文本后立即同步输入状态`,
  );

  content = replaceOnce(
    content,
    `const handleSubmit = (): void => {
  if (props.disabled || !canSubmit.value) {
    return;
  }
  emit('submit');
};
`,
    `const handleSubmit = (): void => {
  syncFromEditor();

  if (props.disabled || !canSubmit.value) {
    return;
  }

  emit('submit');
};
`,
    `${file}: submit 前同步 contenteditable 当前内容`,
  );

  write(file, content);
  return file;
};

const patchSearchResultVirtualizer = () => {
  const file = 'src/components/workbench/sidebar/search/useSearchResultVirtualizer.ts';
  let content = read(file);

  content = replaceOnce(
    content,
    `import { type ComputedRef, computed, type Ref, watch } from 'vue';
`,
    `import { type ComputedRef, computed, nextTick, type Ref, watch } from 'vue';
`,
    `${file}: 引入 nextTick`,
  );

  content = replaceOnce(
    content,
    `  watch(flatSearchRows, () => {
    searchVirtualizer.value.measure();
  });
`,
    `  let previousFirstRowKey: string | null = null;

  watch(
    flatSearchRows,
    async (rows) => {
      const nextFirstRowKey = rows[0]?.key ?? null;
      const shouldResetScroll =
        rows.length === 0 ||
        (previousFirstRowKey !== null && nextFirstRowKey !== previousFirstRowKey);

      previousFirstRowKey = nextFirstRowKey;

      await nextTick();

      if (shouldResetScroll) {
        scrollRef.value?.scrollTo({ top: 0 });
      }

      searchVirtualizer.value.measure();
    },
    { flush: 'post' },
  );
`,
    `${file}: 搜索结果切换时重置滚动并延后测量`,
  );

  write(file, content);
  return file;
};

const main = () => {
  const touched = [patchAiPromptInput(), patchSearchResultVirtualizer()];

  console.log(`\n模式：${apply ? 'apply，已写入文件' : 'dry-run，只检查匹配，不写入'}\n`);

  console.log('处理的核心源码文件：');
  for (const file of touched) {
    console.log(`- ${file}`);
  }

  if (!apply) {
    console.log('\n确认无误后执行：');
    console.log('  node fix-input-submit-and-search-scroll-ux.mjs --apply');
    return;
  }

  console.log('\n已完成。建议继续跑：');
  console.log('  pnpm typecheck');
  console.log('  pnpm test');
};

main();