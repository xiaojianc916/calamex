// scripts/codemod/step6-wire-live-thread.mjs
// 用途：给 executeExternalAgentRequest / resolveSidecarToolConfirmation /
//      resolveSidecarUserQuestion 三条 buffer 回调补 reduce 驱动的 liveThread 接线，
//      与 executeAiRequest(chat) / executeSidecarAgentRequest(agent) 同构（流式保真）。
// 校验对象：当前 main，src/composables/ai/useAiAssistant.ts。
// 运行：node scripts/codemod/step6-wire-live-thread.mjs --check   （干跑，不写）
//      node scripts/codemod/step6-wire-live-thread.mjs            （写入）
// 之后：pnpm typecheck && pnpm lint && pnpm test，确认无回归后手动提交。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : process.cwd();
const CHECK_ONLY = process.argv.includes('--check');

const TARGET = join('src', 'composables', 'ai', 'useAiAssistant.ts');

// --- EOL 保真 ---------------------------------------------------------------
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');
const fromLf = (s, eol) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

// --- 事务式替换：命中数必须等于 count，否则抛错（零写入） ---------------------
const occurrences = (text, needle) => {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = text.indexOf(needle, i);
    if (at < 0) break;
    n += 1;
    i = at + needle.length;
  }
  return n;
};

const planEdit = (text, { find, replace, count, label }) => {
  const hits = occurrences(text, find);
  if (hits !== count) {
    throw new Error(`[${label}] 期望命中 ${count} 处，实际 ${hits} 处；中止（零写入）。`);
  }
  return text.split(find).join(replace);
};

const assertContains = (text, needle, label) => {
  if (!text.includes(needle)) {
    throw new Error(`[self-test] 缺少锚点：${label}`);
  }
};

// --- 锚点（均为 LF）----------------------------------------------------------
const EXTERNAL_FIND = [
  '      applySidecarLiveEventsToAgentMessage(',
  '        assistantMessageId,',
  '        targetThreadId,',
  '        initialActivityText,',
  '        events,',
  '      );',
  '    });',
].join('\n');

const EXTERNAL_REPLACE = [
  '      applySidecarLiveEventsToAgentMessage(',
  '        assistantMessageId,',
  '        targetThreadId,',
  '        initialActivityText,',
  '        events,',
  '      );',
  '      updateLiveThreadFromSidecarEvents(assistantMessageId, targetThreadId, events);',
  '    });',
].join('\n');

const RESOLVE_FIND = [
  '      applySidecarLiveEventsToAgentMessage(',
  '        session.assistantMessageId,',
  '        session.threadId,',
  "        '',",
  '        events,',
  '      );',
  '    });',
].join('\n');

const RESOLVE_REPLACE = [
  '      applySidecarLiveEventsToAgentMessage(',
  '        session.assistantMessageId,',
  '        session.threadId,',
  "        '',",
  '        events,',
  '      );',
  '      updateLiveThreadFromSidecarEvents(session.assistantMessageId, session.threadId, events);',
  '    });',
].join('\n');

// --- 执行 --------------------------------------------------------------------
const path = join(REPO_ROOT, TARGET);
const raw = readFileSync(path, 'utf8');
const eol = detectEol(raw);
let text = toLf(raw);

// 前置自检：锚点存在 + 当前占位为 3（1 定义 + chat + agent）。
assertContains(text, 'const updateLiveThreadFromSidecarEvents = (', 'definition');
assertContains(text, EXTERNAL_FIND, 'external buffer block');
assertContains(text, RESOLVE_FIND, 'resolve buffer block (x2)');

const before = occurrences(text, 'updateLiveThreadFromSidecarEvents');
if (before !== 3) {
  throw new Error(
    `[guard] 预期 updateLiveThreadFromSidecarEvents 出现 3 次（1 定义 + chat + agent），实际 ${before} 次。` +
      ' main 可能已变动，请重新核对后再跑。',
  );
}

// 编辑（事务式）：external(count 1) + resolve(count 2)。
text = planEdit(text, {
  find: EXTERNAL_FIND,
  replace: EXTERNAL_REPLACE,
  count: 1,
  label: 'wire executeExternalAgentRequest',
});
text = planEdit(text, {
  find: RESOLVE_FIND,
  replace: RESOLVE_REPLACE,
  count: 2,
  label: 'wire resolveSidecarToolConfirmation + resolveSidecarUserQuestion',
});

// 后置校验：占位数 3 -> 6（+3）。
const after = occurrences(text, 'updateLiveThreadFromSidecarEvents');
if (after !== 6) {
  throw new Error(`[post-check] 期望接线后出现 6 次，实际 ${after} 次；中止。`);
}

if (CHECK_ONLY) {
  console.log(`[check] OK：${TARGET} 将新增 3 处接线（${before} -> ${after}），未写入。`);
  process.exit(0);
}

writeFileSync(path, fromLf(text, eol), 'utf8');
console.log(`[done] 已写入 ${TARGET}：新增 3 处接线（${before} -> ${after}）。`);