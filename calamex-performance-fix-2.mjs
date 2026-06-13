#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => writeFileSync(join(root, file), content, 'utf8');
const lines = (items) => `${items.join('\n')}\n`;

const replaceOnce = (file, source, target, label) => {
  const content = read(file);
  const count = content.split(source).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${label} expected 1 match, got ${count}`);
  }
  write(file, content.replace(source, target));
  console.log(`updated ${file}: ${label}`);
};

// 1) 时间线展开状态：不要 deep watch 整个 entry 树。
//    这个 watcher 只需要知道“当前 streaming reasoning entry id”，不需要监听
//    reasoning segments、tool raw output、terminal output、diff hunks 等深层文本变化。
replaceOnce(
  'src/components/business/ai/thread/useThreadEntryExpansion.ts',
  lines([
    '    { immediate: true, deep: true },',
  ]),
  lines([
    '    { immediate: true },',
  ]),
  'avoid deep-watching rendered thread entry trees',
);

// 2) 虚拟列表 size-dependencies：避免每个可见 item 都把完整 markdown 文本、
//    toolCall status join、plan step title join 放进依赖数组。
//    DynamicScroller 只需要“可能影响高度”的签名；用长度/数量/状态签名替代完整大字符串。
const aiChatThreadFile = 'src/components/business/ai/chat/AiChatThread.vue';

replaceOnce(
  aiChatThreadFile,
  lines([
    'const handlePlanRemoveStep = (stepId: string): void => {',
    "  emit('planRemoveStep', stepId);",
    '};',
    '',
    'const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => [',
    '  message.content,',
    '  message.stream?.status,',
    '  message.toolCalls?.length ?? 0,',
    "  message.toolCalls?.map((toolCall) => toolCall.status).join('|') ?? '',",
    '  message.actions?.length ?? 0,',
    '  message.attachments?.length ?? 0,',
    '  props.planDetails?.status,',
    '  props.planDetails?.steps?.length ?? 0,',
    "  props.planDetails?.steps?.map((step) => `${step.id}:${step.status}:${step.title}`).join('|') ??",
    "    '',",
    '  props.revertingChangedFilesSummaryId,',
    '  props.pinningChangedFilesSummaryId,',
    '];',
  ]),
  lines([
    'const handlePlanRemoveStep = (stepId: string): void => {',
    "  emit('planRemoveStep', stepId);",
    '};',
    '',
    'const buildMessageContentSizeSignature = (content: string): string => {',
    '  if (content.length <= 256) {',
    '    return content;',
    '  }',
    '',
    '  // Height-affecting changes during streaming are overwhelmingly append-only. Keep a',
    '  // compact signature instead of handing DynamicScroller the whole markdown payload on',
    '  // every render. The tail preserves sensitivity to newly closed blocks/lists/code fences.',
    "  return `${content.length}:${content.slice(0, 64)}:${content.slice(-192)}`;",
    '};',
    '',
    'const buildToolCallSizeSignature = (message: IAiChatMessage): string =>',
    '  message.toolCalls',
    '    ?.map((toolCall) =>',
    '      [',
    '        toolCall.id,',
    '        toolCall.status,',
    '        toolCall.summary.length,',
    '        toolCall.targetPreview?.length ?? 0,',
    "      ].join(':'),",
    '    )',
    "    .join('|') ?? '';",
    '',
    'const planSizeSignature = computed(() =>',
    '  [',
    "    props.planDetails?.status ?? '',",
    '    props.planDetails?.steps',
    "      ?.map((step) => `${step.id}:${step.status}:${step.title.length}`)",
    "      .join('|') ?? '',",
    "  ].join('|'),",
    ');',
    '',
    'const getMessageSizeDependencies = (message: IAiChatMessage): unknown[] => [',
    '  buildMessageContentSizeSignature(message.content),',
    '  message.stream?.status,',
    '  buildToolCallSizeSignature(message),',
    '  message.actions?.length ?? 0,',
    '  message.attachments?.length ?? 0,',
    '  planSizeSignature.value,',
    '  props.revertingChangedFilesSummaryId,',
    '  props.pinningChangedFilesSummaryId,',
    '];',
  ]),
  'compact virtual scroller size dependencies',
);

// 3) 滚动状态：第一批 store 层已经做了 120ms 合并，这里组件层不需要 25fps 发射。
//    提高到 100ms，减少父子事件和 store 调用，不改变最终恢复位置。
replaceOnce(
  aiChatThreadFile,
  lines([
    'const SCROLL_STATE_EMIT_THROTTLE_MS = 40;',
  ]),
  lines([
    'const SCROLL_STATE_EMIT_THROTTLE_MS = 100;',
  ]),
  'reduce virtual chat scroll-state event frequency',
);

console.log('\nSecond performance patch script completed. No backup files were created.');