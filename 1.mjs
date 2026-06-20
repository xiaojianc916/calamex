// 5.mjs — 退役 legacy aiConversation store（ADR-0014 Step 8 ④.3）
// 运行前提：工作树在 1674f5e2（已 git restore 掉 4.mjs 的删除残留）。
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const write = (p, c) => writeFileSync(join(ROOT, p), c, 'utf8');

function replaceOnce(content, oldStr, newStr, label) {
  const parts = content.split(oldStr);
  if (parts.length !== 2) {
    throw new Error(`[${label}] expected exactly 1 match, found ${parts.length - 1}`);
  }
  return parts.join(newStr);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|vue)$/.test(name)) out.push(full);
  }
  return out;
}

// 即将删除的文件（相对 ROOT，posix 风格用于内容扫描排除）
const DELETE_FILES = [
  'src/store/aiConversation.ts',
  'src/store/aiConversation.store.spec.ts',
  'src/store/aiConversation.lazy.store.spec.ts',
  'src/store/aiConversation.perf.store.spec.ts',
  'src/store/aiThread/entriesMirrorBridge.ts',
  'src/store/aiThread/entriesMirrorBridge.spec.ts',
];
const DELETE_SET = new Set(DELETE_FILES.map((p) => join(ROOT, p)));

// ---------------------------------------------------------------------------
// 1) 全局重定向：import type { IAiConversationThread } 的来源 → 中立 schema 模块
// ---------------------------------------------------------------------------
const TYPE_IMPORT_OLD = `import type { IAiConversationThread } from '@/store/aiConversation';`;
const TYPE_IMPORT_NEW = `import type { IAiConversationThread } from '@/types/ai/conversation.schema';`;
let redirected = 0;
for (const full of walk(SRC)) {
  if (DELETE_SET.has(full)) continue;
  const before = readFileSync(full, 'utf8');
  if (before.includes(TYPE_IMPORT_OLD)) {
    writeFileSync(full, before.split(TYPE_IMPORT_OLD).join(TYPE_IMPORT_NEW), 'utf8');
    redirected += 1;
  }
}
console.log(`[redirect] IAiConversationThread 类型来源重定向：${redirected} 个文件`);

// ---------------------------------------------------------------------------
// 2) @/types/ai/conversation.schema.ts —— 接管 IAiConversationThread 类型定义
// ---------------------------------------------------------------------------
{
  const p = 'src/types/ai/conversation.schema.ts';
  let c = read(p);
  c = replaceOnce(
    c,
    `import {\n  aiChatMessageSchema,\n  aiChatRequestSchema,`,
    `import type { IAiChatMessage } from '@/types/ai';\nimport {\n  aiChatMessageSchema,\n  aiChatRequestSchema,`,
    'schema:add-import',
  );
  c = replaceOnce(
    c,
    `  scrollState: aiConversationScrollStateSchema.optional(),\n});`,
    `  scrollState: aiConversationScrollStateSchema.optional(),\n});\n\n/**\n * Thread 的 wire 形状由 schema 推断（单一来源），UI 层覆写 messages 为含 UI 衍生字段\n * 的消息。原定义自 @/store/aiConversation 迁来（该 legacy store 已退役），作为 legacy\n * 适配器 / 持久化读路径的中立类型来源，杜绝对已删除 store 的依赖。\n */\ntype IAiConversationThreadWire = z.infer<typeof aiConversationThreadSchema>;\nexport interface IAiConversationThread extends Omit<IAiConversationThreadWire, 'messages'> {\n  messages: IAiChatMessage[];\n}`,
    'schema:add-type',
  );
  write(p, c);
  console.log(`[schema] ${p} 已接管 IAiConversationThread`);
}

// ---------------------------------------------------------------------------
// 3) startupPersistedReadWiring.ts —— 去掉 store 依赖，readLegacy 默认返回空
// ---------------------------------------------------------------------------
{
  const p = 'src/store/aiThread/startupPersistedReadWiring.ts';
  let c = read(p);
  c = replaceOnce(c, `import { useAiConversationStore } from '@/store/aiConversation';\n`, ``, 'wiring:rm-import');
  c = replaceOnce(
    c,
    `export const defaultDeps: IRunStartupPersistedReadDeps = {\n  readLegacy: () => {\n    const conversation = useAiConversationStore();\n    return {\n      legacyActiveThreadId: conversation.activeThreadId,\n      legacyThreads: conversation.threads,\n    };\n  },\n  hydrateForRender: hydrateAiThreadEntriesForRender,`,
    `export const defaultDeps: IRunStartupPersistedReadDeps = {\n  // legacy aiConversation store 已退役：迁移已完成，新 entries key 为唯一持久化真源。\n  // 保留 readLegacy 形状（DI 缝与单测仍可注入 legacy 回退），生产默认不再提供 legacy 源。\n  readLegacy: () => ({ legacyActiveThreadId: null, legacyThreads: [] }),\n  hydrateForRender: hydrateAiThreadEntriesForRender,`,
    'wiring:readLegacy',
  );
  write(p, c);
  console.log(`[wiring] ${p} 已切断 legacy store`);
}

// ---------------------------------------------------------------------------
// 4) aiThread/index.ts —— 移除 projectedActiveThread 与 store 引用
// ---------------------------------------------------------------------------
{
  const p = 'src/store/aiThread/index.ts';
  let c = read(p);
  c = replaceOnce(c, `import { useAiConversationStore } from '@/store/aiConversation';\n`, ``, 'index:rm-store-import');
  c = replaceOnce(
    c,
    `import {\n  legacyMessageToEntries,\n  legacyThreadToThread,\n  threadEntriesToMessages,\n  threadToLegacyThread,\n} from '@/store/aiThread/legacy-adapter';`,
    `import {\n  legacyMessageToEntries,\n  threadEntriesToMessages,\n  threadToLegacyThread,\n} from '@/store/aiThread/legacy-adapter';`,
    'index:trim-adapter-import',
  );
  c = replaceOnce(
    c,
    `  const conversation = useAiConversationStore();\n\n  /**\n   * 活动流式线程`,
    `  /**\n   * 活动流式线程`,
    'index:rm-conversation-const',
  );
  c = replaceOnce(
    c,
    `  /** 把 legacy active thread 适配为 entries 模型（只读派生）。 */\n  const projectedActiveThread = computed<IAiThread | null>(() =>\n    conversation.activeThread ? legacyThreadToThread(conversation.activeThread) : null,\n  );\n\n  const activeThread = computed<IAiThread | null>(\n    () => liveThread.value ?? projectedActiveThread.value ?? persistedActiveThread.value,\n  );`,
    `  const activeThread = computed<IAiThread | null>(\n    () => liveThread.value ?? persistedActiveThread.value,\n  );`,
    'index:rm-projected',
  );
  c = replaceOnce(
    c,
    `    // getters\n    projectedActiveThread,\n    persistedActiveThread,`,
    `    // getters\n    persistedActiveThread,`,
    'index:rm-projected-return',
  );
  write(p, c);
  console.log(`[index] ${p} 已移除 projectedActiveThread`);
}

// ---------------------------------------------------------------------------
// 5) persisted-read.spec.ts —— 去掉 aiConversation mock + 改测试标题
// ---------------------------------------------------------------------------
{
  const p = 'src/store/aiThread/persisted-read.spec.ts';
  let c = read(p);
  c = replaceOnce(
    c,
    `// 隔离持久化读路径：legacy 投影置空 (activeThread=null)；指针恢复注入假实现。\nconst { restoreMock } = vi.hoisted(() => ({ restoreMock: vi.fn() }));\n\nvi.mock('@/store/aiConversation', () => ({\n  useAiConversationStore: () => ({ activeThread: null }),\n}));\nvi.mock('@/store/plugins/debouncedPersistStorage', () => ({`,
    `// 隔离持久化读路径：指针恢复注入假实现。\nconst { restoreMock } = vi.hoisted(() => ({ restoreMock: vi.fn() }));\n\nvi.mock('@/store/plugins/debouncedPersistStorage', () => ({`,
    'persisted-read:rm-mock',
  );
  c = replaceOnce(
    c,
    `  it('activeThread 优先级 live > persisted > projected', async () => {\n    const store = useAiThreadStore();\n    expect(store.activeThread).toBeNull(); // projected 为 null（mock）`,
    `  it('activeThread 优先级 live > persisted', async () => {\n    const store = useAiThreadStore();\n    expect(store.activeThread).toBeNull(); // 无 live / persisted → null`,
    'persisted-read:retitle',
  );
  write(p, c);
  console.log(`[spec] ${p} 已去 mock`);
}

// ---------------------------------------------------------------------------
// 6) render-fallback-priority.spec.ts —— 三路回退降为两路
// ---------------------------------------------------------------------------
{
  const p = 'src/store/aiThread/render-fallback-priority.spec.ts';
  let c = read(p);
  // 头部注释：三路 → 两路
  c = replaceOnce(
    c,
    ` *   1) activeThread 三层回退优先级：liveThread > projectedActiveThread > persistedActiveThread\n *      —— 锁定 7.5b 修复后的顺序（修复前曾是 persisted-first，会渲染过期 UI）。\n *      现有 persisted-read.spec.ts 把 conversation 强制 mock 为 null，无法覆盖\n *      projected-vs-persisted 这一关键档；本 harness 专门补上。`,
    ` *   1) activeThread 两路回退优先级：liveThread > persistedActiveThread\n *      —— legacy 投影（projectedActiveThread）随 aiConversation store 退役已移除，\n *      此前的 projected 档一并下线，仅保留 live / persisted 两路回归锁。`,
    'fallback:header-1',
  );
  c = replaceOnce(
    c,
    ` * 隔离策略与 persisted-read.spec.ts 对齐：conversation 投影源与指针恢复均被 mock，\n * read 管线通过 7.5a/7.5c 暴露的 DI 缝注入假快照与真 resolver。`,
    ` * 隔离策略与 persisted-read.spec.ts 对齐：指针恢复被 mock，\n * read 管线通过 7.5a/7.5c 暴露的 DI 缝注入假快照与真 resolver。`,
    'fallback:header-2',
  );
  // 去掉 conversationState 持有 + aiConversation mock
  c = replaceOnce(
    c,
    `// conversation 投影源：可变持有，注入 legacy 活动线程以驱动 projectedActiveThread。\nconst { conversationState } = vi.hoisted(() => ({\n  conversationState: { activeThread: null as IAiConversationThread | null },\n}));\n\nvi.mock('@/store/aiConversation', () => ({\n  useAiConversationStore: () => ({ activeThread: conversationState.activeThread }),\n}));\nvi.mock('@/store/plugins/debouncedPersistStorage', () => ({`,
    `vi.mock('@/store/plugins/debouncedPersistStorage', () => ({`,
    'fallback:rm-mock',
  );
  // beforeEach 去掉 conversationState 重置
  c = replaceOnce(
    c,
    `beforeEach(() => {\n  setActivePinia(createPinia());\n  conversationState.activeThread = null;\n});`,
    `beforeEach(() => {\n  setActivePinia(createPinia());\n});`,
    'fallback:beforeEach',
  );
  // 第一组 describe：三路 → 两路
  c = replaceOnce(
    c,
    `describe('渲染回退三路优先级（回归 harness）', () => {\n  it('projected 缺席 → 回退到 persisted', async () => {\n    const store = useAiThreadStore();\n    expect(store.activeThread).toBeNull();\n\n    store.setPersistedThreads([makeThread('persisted')], 'persisted');\n    await flush();\n    expect(store.activeThread?.id).toBe('persisted');\n  });\n\n  it('三路同存：live > projected > persisted（锁定修复后的顺序）', async () => {\n    conversationState.activeThread = makeLegacyThread('projected');\n    const store = useAiThreadStore();\n\n    store.setPersistedThreads([makeThread('persisted')], 'persisted');\n    await flush();\n    // projected 在场必须压过 persisted —— 修复前 persisted-first bug 的回归锁。\n    expect(store.activeThread?.id).toBe('projected');\n\n    store.setLiveThread(makeThread('live'));\n    expect(store.activeThread?.id).toBe('live');\n\n    store.setLiveThread(null);\n    expect(store.activeThread?.id).toBe('projected');\n  });\n\n  it('activeEntries 跟随 activeThread', async () => {`,
    `describe('渲染回退两路优先级（回归 harness）', () => {\n  it('persisted 缺席 → activeThread 为 null', async () => {\n    const store = useAiThreadStore();\n    expect(store.activeThread).toBeNull();\n  });\n\n  it('两路同存：live > persisted（legacy 投影退役后）', async () => {\n    const store = useAiThreadStore();\n\n    store.setPersistedThreads([makeThread('persisted')], 'persisted');\n    await flush();\n    expect(store.activeThread?.id).toBe('persisted');\n\n    store.setLiveThread(makeThread('live'));\n    expect(store.activeThread?.id).toBe('live');\n\n    store.setLiveThread(null);\n    expect(store.activeThread?.id).toBe('persisted');\n  });\n\n  it('activeEntries 跟随 activeThread', async () => {`,
    'fallback:describe',
  );
  write(p, c);
  console.log(`[spec] ${p} 三路→两路`);
}

// ---------------------------------------------------------------------------
// 7) 护栏：删除前全量扫描，任何残留引用即中止（绝不重演 4.mjs）
// ---------------------------------------------------------------------------
const stragglers = [];
for (const full of walk(SRC)) {
  if (DELETE_SET.has(full)) continue;
  const c = readFileSync(full, 'utf8');
  if (c.includes(`@/store/aiConversation`) || c.includes(`aiThread/entriesMirrorBridge`)) {
    stragglers.push(posix.relative(ROOT.split('\\').join('/'), full.split('\\').join('/')));
  }
}
if (stragglers.length > 0) {
  throw new Error(
    `[GUARD] 仍有文件引用待删模块，已中止删除：\n  - ${stragglers.join('\n  - ')}`,
  );
}
console.log('[guard] 无残留引用，可安全删除');

// ---------------------------------------------------------------------------
// 8) 删除 legacy store + 孤儿 entriesMirrorBridge（含各自 spec）
// ---------------------------------------------------------------------------
for (const rel of DELETE_FILES) {
  const abs = join(ROOT, rel);
  if (existsSync(abs)) {
    rmSync(abs);
    console.log(`[delete] ${rel}`);
  } else {
    console.warn(`[delete] 跳过（不存在）：${rel}`);
  }
}

console.log('\n✅ 完成。请运行：pnpm typecheck && pnpm lint && pnpm test');