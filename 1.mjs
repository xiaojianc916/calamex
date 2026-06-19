#!/usr/bin/env node
/**
 * Step 6 真·上线:entries 渲染路径从「流式瞬时点亮」改为「持久生效」。
 *   1) store/aiThread: renderFromEntries 默认 ref(false) -> ref(true)
 *   2) useAiAssistant: 收尾不再 setRenderFromEntries(false)(仍 setLiveThread(null),
 *      空闲/历史/外部 agent/续跑回落 projectedActiveThread = legacy->entries)
 * 从仓库根运行: node scripts/codemod/step6-go-live.mjs
 * 跑完: pnpm typecheck && pnpm lint && pnpm test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = process.cwd();
const abs = (rel) => resolve(repoRoot, rel);
const toLf = (s) => s.replace(/\r\n/g, '\n');
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const fromLf = (s, eol) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

const plans = [];
function planEdit(rel, edits) {
  const original = readFileSync(abs(rel), 'utf8');
  const eol = detectEol(original);
  let body = toLf(original);
  for (const { find, replace, label } of edits) {
    const needle = toLf(find);
    const hits = body.split(needle).length - 1;
    if (hits !== 1) {
      throw new Error('[step6-go-live] 锚点命中 ' + hits + ' 次 (期望 1): ' + rel + ' :: ' + label);
    }
    body = body.replace(needle, () => toLf(replace)); // 函数式 replace,规避 $ 特殊串
  }
  plans.push({ rel, content: fromLf(body, eol), eol });
}

const J = (lines) => lines.join('\n');

// ---- Edit 1: store/aiThread/index.ts ----
planEdit('src/store/aiThread/index.ts', [
  {
    label: 'renderFromEntries default ref(false) -> ref(true)',
    find: '  const renderFromEntries = ref(false);',
    replace: '  const renderFromEntries = ref(true);',
  },
]);

// ---- Edit 2: composables/ai/useAiAssistant.ts ----
planEdit('src/composables/ai/useAiAssistant.ts', [
  {
    label: 'syncDisplayMessagesFromActiveThread 不再回退 renderFromEntries=false',
    find: J([
      '  const syncDisplayMessagesFromActiveThread = (): void => {',
      '    if (!isConversationWriteBuffered()) {',
      '      displayMessages.value = unref(conversationStore.activeMessages);',
      '      aiThreadStore.setLiveThread(null);',
      '      aiThreadStore.setRenderFromEntries(false);',
      '    }',
      '  };',
    ]),
    replace: J([
      '  const syncDisplayMessagesFromActiveThread = (): void => {',
      '    if (!isConversationWriteBuffered()) {',
      '      displayMessages.value = unref(conversationStore.activeMessages);',
      '      // Step 6 持久上线:回落到 projectedActiveThread(legacy->entries),不再退回旧 message 路径。',
      '      aiThreadStore.setLiveThread(null);',
      '    }',
      '  };',
    ]),
  },
]);

// ---- commit (all-or-nothing) ----
for (const p of plans) {
  writeFileSync(abs(p.rel), p.content, 'utf8');
  console.log('updated ' + p.rel);
}

// ---- self-test ----
const assertContains = (rel, s) => {
  if (!toLf(readFileSync(abs(rel), 'utf8')).includes(toLf(s))) {
    throw new Error('[step6-go-live] 自检失败,未找到: ' + rel + ' :: ' + s);
  }
};
assertContains('src/store/aiThread/index.ts', 'const renderFromEntries = ref(true);');
assertContains('src/composables/ai/useAiAssistant.ts', '不再退回旧 message 路径');
console.log('done. 接着跑: pnpm typecheck && pnpm lint && pnpm test');