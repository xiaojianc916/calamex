#!/usr/bin/env node
/**
 * fix-ai-hot-path-ux.mjs
 *
 * 修复用户可感知的 AI 热路径问题：
 *
 * 1. AiPromptInput.vue
 *    - 每次输入都无差别写 selectedSkills，导致父级/下游响应链被无意义触发。
 *    - 改为文本变了才写 modelValue，技能列表变了才写 selectedSkills。
 *
 * 2. AiChatThread.vue
 *    - getMessageSizeDependencies 每次都创建新数组，虚拟列表容易重复测量。
 *    - 按 message id + signature 缓存 size-dependencies 数组，减少流式输出时的布局抖动。
 *
 * 用法：
 *   node fix-ai-hot-path-ux.mjs
 *   node fix-ai-hot-path-ux.mjs --apply
 *
 * 不生成备份文件。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');

const abs = (file) => join(root, file);
const read = (file) => readFileSync(abs(file), 'utf8');

const write = (file, content) => {
  if (apply) {
    writeFileSync(abs(file), content, 'utf8');
  }
};

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

const ensureFile = (file) => {
  if (!existsSync(abs(file))) {
    fail(`缺少文件：${file}`);
  }
};

const normalizeLf = (text) => text.replace(/\r\n/g, '\n');

const replaceOnce = (content, oldText, newText, label) => {
  const count = content.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}：期望匹配 1 次，实际 ${count} 次`);
  }
  return content.replace(oldText, newText);
};

const insertAfterOnce = (content, anchor, insertion, label) => {
  if (content.includes(insertion.trim())) {
    console.log(`• 已存在，跳过：${label}`);
    return content;
  }

  const count = content.split(anchor).length - 1;
  if (count !== 1) {
    fail(`${label}：期望 anchor 匹配 1 次，实际 ${count} 次`);
  }

  return content.replace(anchor, `${anchor}${insertion}`);
};

const patchAiPromptInput = () => {
  const file = 'src/components/business/ai/chat/AiPromptInput.vue';
  ensureFile(file);

  let content = normalizeLf(read(file));

  const oldBlock = `const syncFromEditor = (): void => {
  if (isApplyingExternalValue) {
    return;
  }
  const { text, skills } = serializeEditor();
  modelValue.value = text;
  selectedSkills.value = skills;
};
`;

  const newBlock = `const syncFromEditor = (): void => {
  if (isApplyingExternalValue) {
    return;
  }

  const { text, skills } = serializeEditor();

  if (modelValue.value !== text) {
    modelValue.value = text;
  }

  if (!skillsEqual(selectedSkills.value ?? [], skills)) {
    selectedSkills.value = skills;
  }
};
`;

  if (content.includes(newBlock)) {
    console.log(`• 已存在，跳过：${file}: 输入同步去掉无意义 selectedSkills 写入`);
  } else {
    content = replaceOnce(
      content,
      oldBlock,
      newBlock,
      `${file}: 输入同步去掉无意义 selectedSkills 写入`,
    );
  }

  write(file, content);
  return file;
};

const patchAiChatThread = () => {
  const file = 'src/components/business/ai/chat/AiChatThread.vue';
  ensureFile(file);

  let content = normalizeLf(read(file));

  content = insertAfterOnce(
    content,
    `const SCROLLBAR_ACTIVE_MS = 900;
`,
    `const MESSAGE_SIZE_DEPENDENCY_CACHE_LIMIT = 300;
`,
    `${file}: 添加消息 size dependency 缓存上限`,
  );

  const oldBlock = `const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => [
  buildMessageContentSizeSignature(message.content),
  message.stream?.status,
  buildToolCallSizeSignature(message),
  message.actions?.length ?? 0,
  message.attachments?.length ?? 0,
  planSizeSignature.value,
  props.revertingChangedFilesSummaryId,
  props.pinningChangedFilesSummaryId,
];
`;

  const newBlock = `type TMessageSizeDependencyCacheEntry = {
  signature: string;
  dependencies: unknown[];
};

const messageSizeDependencyCache = new Map<string, TMessageSizeDependencyCacheEntry>();

const trimMessageSizeDependencyCache = (currentMessageId: string): void => {
  if (
    messageSizeDependencyCache.size < MESSAGE_SIZE_DEPENDENCY_CACHE_LIMIT ||
    messageSizeDependencyCache.has(currentMessageId)
  ) {
    return;
  }

  const firstKey = messageSizeDependencyCache.keys().next().value;
  if (typeof firstKey === 'string') {
    messageSizeDependencyCache.delete(firstKey);
  }
};

const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => {
  const dependencies = [
    buildMessageContentSizeSignature(message.content),
    message.stream?.status,
    buildToolCallSizeSignature(message),
    message.actions?.length ?? 0,
    message.attachments?.length ?? 0,
    planSizeSignature.value,
    props.revertingChangedFilesSummaryId,
    props.pinningChangedFilesSummaryId,
  ];

  const signature = dependencies.map((value) => String(value ?? '')).join('\\u001f');
  const cached = messageSizeDependencyCache.get(message.id);

  if (cached?.signature === signature) {
    return cached.dependencies;
  }

  trimMessageSizeDependencyCache(message.id);
  messageSizeDependencyCache.set(message.id, { signature, dependencies });
  return dependencies;
};
`;

  if (content.includes('const messageSizeDependencyCache = new Map')) {
    console.log(`• 已存在，跳过：${file}: 缓存 message size dependencies`);
  } else {
    content = replaceOnce(
      content,
      oldBlock,
      newBlock,
      `${file}: 缓存 message size dependencies，减少虚拟列表重复测量`,
    );
  }

  write(file, content);
  return file;
};

const main = () => {
  const touched = [];

  touched.push(patchAiPromptInput());
  touched.push(patchAiChatThread());

  console.log(`\n模式：${apply ? 'apply，已写入文件' : 'dry-run，只检查匹配，不写入'}\n`);

  console.log('处理的核心源码文件：');
  for (const file of touched) {
    console.log(`- ${file}`);
  }

  if (!apply) {
    console.log('\n确认无误后执行：');
    console.log('  node fix-ai-hot-path-ux.mjs --apply');
    return;
  }

  console.log('\n已完成。建议继续跑：');
  console.log('  pnpm typecheck');
  console.log('  pnpm test');
};

main();