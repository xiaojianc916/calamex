#!/usr/bin/env node
/* ============================================================================
 * 3.mjs — ADR-0014 Step 8 ④.1 §C+§D+§E+§F 原子切换
 *
 * 把「持久化 SoT + 编排器消息读写」从 legacy aiConversation 收敛到 aiThread 权威
 * entries（Approach B 无损 entries 已在前两个脚本落地）。四段运行期耦合，必须同提交：
 *   §C main.ts        启动读结果灌入「权威线程」+ 安装「权威镜像」（替换 legacy 镜像）
 *   §D useAiAssistant 编排器消息真源切到 aiThread（drop-in 别名）；活动/历史线程改读
 *                      legacy 形状 getter；流式覆盖改 overlay（按 id upsert，保历史）；
 *                      收尾不再 setStreamingActiveThread(null)（否则抹掉权威历史）
 *   §E titles         标题组合式的 store 类型切到 aiThread（drop-in 同名方法）
 *   §F spec           被测 store 引用切到 aiThread；断言改读 drop-in 形状
 *
 * 安全性：先把全部文件改动算到内存（任一锚点缺失即抛错），全部成功后才统一落盘。
 * ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const mk = (lines) => lines.join('\n');

function applyOnce(content, find, replace, tag) {
  const idx = content.indexOf(find);
  if (idx === -1) throw new Error(`[${tag}] anchor NOT FOUND`);
  if (content.indexOf(find, idx + find.length) !== -1)
    throw new Error(`[${tag}] anchor NOT UNIQUE`);
  return content.slice(0, idx) + replace + content.slice(idx + find.length);
}

function applyAll(content, find, replace, tag, expected) {
  const parts = content.split(find);
  const count = parts.length - 1;
  if (count !== expected)
    throw new Error(`[${tag}] expected ${expected} occurrences, found ${count}`);
  return parts.join(replace);
}

function buildFile(rel, ops) {
  let content = read(rel);
  for (const op of ops) {
    content =
      op.all !== undefined
        ? applyAll(content, op.find, op.replace, op.tag, op.all)
        : applyOnce(content, op.find, op.replace, op.tag);
  }
  return [rel, content];
}

// ===========================================================================
// §C — src/app/main.ts
// ===========================================================================
const mainOps = [
  {
    tag: 'C1:imports',
    find: mk([
      "import { useAiConversationStore } from '@/store/aiConversation';",
      "import { installEntriesMirror } from '@/store/aiThread/entriesMirrorBridge';",
      "import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';",
    ]),
    replace: mk([
      "import { useAiThreadStore } from '@/store/aiThread';",
      "import { installAuthoritativeEntriesMirror } from '@/store/aiThread/authoritativeEntriesMirror';",
      'import {',
      '  defaultDeps as startupPersistedReadDefaultDeps,',
      '  runStartupPersistedRead,',
      "} from '@/store/aiThread/startupPersistedReadWiring';",
    ]),
  },
  {
    tag: 'C2:wiring',
    find: mk([
      '        void hydrateAiConversationStorage()',
      '          .then(() => runStartupPersistedRead())',
      '          .then(() => {',
      '            // 7.4d 双写接线：必须在 legacy hydrate + 读侧回退槽填充之后再装镜像，',
      '            // 否则首次立即镜像会把空态写入权威新 key，导致下次启动读到“空且权威”而丢历史。',
      '            installEntriesMirror(useAiConversationStore());',
      '          })',
    ]),
    replace: mk([
      '        void hydrateAiConversationStorage()',
      '          .then(() =>',
      '            runStartupPersistedRead({',
      '              ...startupPersistedReadDefaultDeps,',
      '              // ④.1 §C：持久化 SoT 收敛到 aiThread 权威 entries，启动读结果直接灌入',
      '              // 权威线程（不再走 legacy 回退槽），后续由权威镜像负责落盘。',
      '              applyPersisted: (threads, activeThreadId) =>',
      '                useAiThreadStore().setAuthoritativeThreads(threads, activeThreadId),',
      '            }),',
      '          )',
      '          .then(() => {',
      '            // ④.1 §C 双写接线：必须在 legacy hydrate + 权威线程灌入之后再装权威镜像，',
      '            // 否则首帧立即镜像会把空态写入 entries key，导致下次启动读到“空且权威”而丢历史。',
      '            installAuthoritativeEntriesMirror(useAiThreadStore());',
      '          })',
    ]),
  },
];

// ===========================================================================
// §D — src/composables/ai/useAiAssistant.ts
// ===========================================================================
const orchestratorOps = [
  {
    tag: 'D1:import-drop-legacy',
    find: "import { type IAiConversationScrollState, useAiConversationStore } from '@/store/aiConversation';",
    replace: "import { type IAiConversationScrollState } from '@/store/aiConversation';",
  },
  {
    tag: 'D2:declaration-alias',
    find: mk([
      '  const agentStore = useAiAgentStore();',
      '  const conversationStore = useAiConversationStore();',
      '  const aiThreadStore = useAiThreadStore();',
    ]),
    replace: mk([
      '  const agentStore = useAiAgentStore();',
      '  const aiThreadStore = useAiThreadStore();',
      '  // ④.1 §D：编排器消息读写真源收敛到 aiThread 权威 entries（drop-in）。conversationStore',
      '  // 别名保留以最小化触点；活动/历史线程改读 legacy 形状 getter（activeConversationThread /',
      '  // conversationHistoryThreads），其余面（activeMessages / activeThreadId / replace* / 生命周期）1:1 同名。',
      '  const conversationStore = aiThreadStore;',
    ]),
  },
  {
    tag: 'D3:liveThread-source',
    find: '    const activeThread = conversationStore.activeThread;',
    replace: '    const activeThread = conversationStore.activeConversationThread;',
  },
  {
    tag: 'D4:setStreaming->overlay',
    find: mk([
      '    aiThreadStore.setStreamingActiveThread(',
      '      buildLiveThreadFromSidecarEvents(events, {',
    ]),
    replace: mk([
      '    aiThreadStore.overlayStreamingActiveThread(',
      '      buildLiveThreadFromSidecarEvents(events, {',
    ]),
  },
  {
    tag: 'D5:sync-drop-reset',
    find: mk([
      '    if (!isConversationWriteBuffered()) {',
      '      displayMessages.value = unref(conversationStore.activeMessages);',
      '      // Step 6 持久上线:回落到 projectedActiveThread(legacy->entries),不再退回旧 message 路径。',
      '      aiThreadStore.setStreamingActiveThread(null);',
      '    }',
    ]),
    replace: mk([
      '    if (!isConversationWriteBuffered()) {',
      '      // ④.1 §D：权威 entries 已是 SoT，收尾仅回读消息缓冲；不再 setStreamingActiveThread(null)',
      '      // （那会把权威线程复位为单空线程、抹掉历史）。最终态由 commitDisplayMessagesToStore 落定。',
      '      displayMessages.value = unref(conversationStore.activeMessages);',
      '    }',
    ]),
  },
  {
    tag: 'D6:historyThreads',
    find: '  const historyThreads = computed(() => unref(conversationStore.historyThreads));',
    replace:
      '  const historyThreads = computed(() => unref(conversationStore.conversationHistoryThreads));',
  },
  {
    tag: 'D7:scrollState',
    find: mk([
      '  const activeConversationScrollState = computed<IAiConversationScrollState | null>(',
      '    () => conversationStore.activeThread?.scrollState ?? null,',
      '  );',
    ]),
    replace: mk([
      '  const activeConversationScrollState = computed<IAiConversationScrollState | null>(',
      '    () => conversationStore.activeConversationThread?.scrollState ?? null,',
      '  );',
    ]),
  },
];

// ===========================================================================
// §E — src/composables/ai/useAiAssistant.conversation-titles.ts
// ===========================================================================
const titlesOps = [
  {
    tag: 'E1:import',
    find: "import type { useAiConversationStore } from '@/store/aiConversation';",
    replace: "import type { useAiThreadStore } from '@/store/aiThread';",
  },
  {
    tag: 'E2:type',
    find: 'type IAiConversationStore = ReturnType<typeof useAiConversationStore>;',
    replace: 'type IAiConversationStore = ReturnType<typeof useAiThreadStore>;',
  },
];

// ===========================================================================
// §F — src/composables/ai/useAiAssistant.spec.ts
// ===========================================================================
const specOps = [
  {
    tag: 'F1:import',
    find: "import { useAiConversationStore } from '@/store/aiConversation';",
    replace: "import { useAiThreadStore } from '@/store/aiThread';",
  },
  {
    tag: 'F2:store-decls',
    all: 8,
    find: 'const conversationStore = useAiConversationStore();',
    replace: 'const conversationStore = useAiThreadStore();',
  },
  {
    tag: 'F3:activeThread-getter',
    all: 5,
    find: 'readReactiveValue(conversationStore.activeThread)',
    replace: 'readReactiveValue(conversationStore.activeConversationThread)',
  },
  {
    tag: 'F4:threads-find',
    find: 'conversationStore.threads.find((thread) => thread.id === sourceThreadId)',
    replace:
      'conversationStore.conversationHistoryThreads.find((thread) => thread.id === sourceThreadId)',
  },
];

// ===========================================================================
// Build all (throws before any write if an anchor is missing) → then flush
// ===========================================================================
const plan = [
  ['src/app/main.ts', mainOps],
  ['src/composables/ai/useAiAssistant.ts', orchestratorOps],
  ['src/composables/ai/useAiAssistant.conversation-titles.ts', titlesOps],
  ['src/composables/ai/useAiAssistant.spec.ts', specOps],
];

const built = plan.map(([rel, ops]) => buildFile(rel, ops));
for (const [rel, content] of built) writeFileSync(resolve(ROOT, rel), content);
for (const [rel, ops] of plan) console.log(`✓ ${rel} (${ops.length} ops)`);
console.log('✅ ④.1 §C+§D+§E+§F 原子切换完成');