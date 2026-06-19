#!/usr/bin/env node
// scripts/codemod/step7-5b-thread-store-persisted-read.mjs
//
// 7.5b — aiThread store 改造（Step 7 持久化读路径 / dual-read）
//
// 1) 编辑 src/store/aiThread/index.ts：
//    - import vue 增补 watch
//    - 增补 import restoreAttachmentPreviewPointers（@/store/plugins/debouncedPersistStorage）
//    - 新增 persistedThreads / persistedActiveThreadId 状态、persistedActiveThread 派生、
//      restorePersistedThreadPointers + watch 惰性恢复钩子
//    - activeThread 优先级改为 live ?? persisted ?? projected
//    - 新增 setPersistedThreads / setPersistedActiveThreadId 动作并导出
// 2) 创建 src/store/aiThread/persisted-read.spec.ts
//
// 幂等：index.ts 若已含 'setPersistedActiveThreadId' 则跳过编辑；spec 已存在则跳过创建（除非 --force）。
//
// 用法：
//   node scripts/codemod/step7-5b-thread-store-persisted-read.mjs --check
//   node scripts/codemod/step7-5b-thread-store-persisted-read.mjs
//   node scripts/codemod/step7-5b-thread-store-persisted-read.mjs --force
//   REPO_ROOT=/path node scripts/codemod/step7-5b-thread-store-persisted-read.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const ARGS = new Set(process.argv.slice(2));
const CHECK = ARGS.has('--check');
const FORCE = ARGS.has('--force');

const log = (...a) => console.log('[step7-5b]', ...a);
const fail = (msg) => {
  console.error('[step7-5b] ✗', msg);
  process.exit(1);
};

const STORE = 'src/store/aiThread/index.ts';
const SPEC = 'src/store/aiThread/persisted-read.spec.ts';
const STORE_SENTINEL = 'setPersistedActiveThreadId';

// ---- index.ts 锚点编辑（顺序应用，每个锚点必须唯一） --------------------------
const EDITS = [
  {
    name: 'import vue: +watch',
    find: "import { computed, ref } from 'vue';",
    replace: "import { computed, ref, watch } from 'vue';",
  },
  {
    name: 'import restoreAttachmentPreviewPointers',
    find:
      "import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';\n" +
      "import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';",
    replace:
      "import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';\n" +
      "import { restoreAttachmentPreviewPointers } from '@/store/plugins/debouncedPersistStorage';\n" +
      "import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';",
  },
  {
    name: 'persisted state + lazy-restore hook',
    find:
      "  const liveThread = ref<IAiThread | null>(null);\n\n" +
      "  /** 把 legacy active thread 适配为 entries 模型（只读派生）。 */\n",
    replace:
      "  const liveThread = ref<IAiThread | null>(null);\n\n" +
      "  /* ----- 7.5b 持久化/迁移读侧（Step 7 dual-read） --------------------------\n" +
      "   * 启动迁移把旧 key 投影/救援出的 entries 线程灌入这里（见 7.5c 接线），\n" +
      "   * 作为 legacy 投影之上、liveThread 之下的优先回退来源。\n" +
      "   * 附件预览指针按「活动线程切换」惰性恢复，复用 restoreAttachmentPreviewPointers。\n" +
      "   * ----------------------------------------------------------------------- */\n" +
      "  const persistedThreads = ref<IAiThread[]>([]);\n" +
      "  const persistedActiveThreadId = ref<string | null>(null);\n\n" +
      "  /** 已完成指针惰性恢复的线程 id（去重；换库时清空）。 */\n" +
      "  const restoredThreadIds = new Set<string>();\n\n" +
      "  const persistedActiveThread = computed<IAiThread | null>(() => {\n" +
      "    const id = persistedActiveThreadId.value;\n" +
      "    if (!id) return null;\n" +
      "    return persistedThreads.value.find((thread) => thread.id === id) ?? null;\n" +
      "  });\n\n" +
      "  /**\n" +
      "   * 惰性恢复指定持久化线程的附件预览指针（idb:// → base64）。\n" +
      "   * - 每线程每会话最多一次（restoredThreadIds 去重，同步登记防并发重入）。\n" +
      "   * - await 期间数组可能被替换：回写前按 id 重定位并校验对象身份未变，\n" +
      "   *   避免覆盖更新的快照（不可变 splice 回写，与 7.5a 一致）。\n" +
      "   */\n" +
      "  async function restorePersistedThreadPointers(threadId: string): Promise<void> {\n" +
      "    if (restoredThreadIds.has(threadId)) return;\n" +
      "    const target = persistedThreads.value.find((thread) => thread.id === threadId);\n" +
      "    if (!target) return;\n" +
      "    restoredThreadIds.add(threadId);\n" +
      "    try {\n" +
      "      const { changed, value } = await restoreAttachmentPreviewPointers(target);\n" +
      "      if (!changed) return;\n" +
      "      const current = persistedThreads.value;\n" +
      "      const at = current.findIndex((thread) => thread.id === threadId);\n" +
      "      if (at < 0 || current[at] !== target) return;\n" +
      "      const next = current.slice();\n" +
      "      next[at] = value;\n" +
      "      persistedThreads.value = next;\n" +
      "    } catch {\n" +
      "      // 恢复失败非致命：指针保持 idb://，下游按缺图处理；允许后续重试。\n" +
      "      restoredThreadIds.delete(threadId);\n" +
      "    }\n" +
      "  }\n\n" +
      "  /** 活动持久化线程切换时触发惰性指针恢复。 */\n" +
      "  watch(\n" +
      "    persistedActiveThreadId,\n" +
      "    (id) => {\n" +
      "      if (id) void restorePersistedThreadPointers(id);\n" +
      "    },\n" +
      "    { immediate: false },\n" +
      "  );\n\n" +
      "  /** 把 legacy active thread 适配为 entries 模型（只读派生）。 */\n",
  },
  {
    name: 'activeThread priority: + persisted',
    find:
      "  const activeThread = computed<IAiThread | null>(\n" +
      "    () => liveThread.value ?? projectedActiveThread.value,\n" +
      "  );",
    replace:
      "  const activeThread = computed<IAiThread | null>(\n" +
      "    () => liveThread.value ?? persistedActiveThread.value ?? projectedActiveThread.value,\n" +
      "  );",
  },
  {
    name: 'actions: setPersistedThreads / setPersistedActiveThreadId',
    find:
      "  function setRenderFromEntries(value: boolean): void {\n" +
      "    renderFromEntries.value = value;\n" +
      "  }\n\n" +
      "  return {",
    replace:
      "  function setRenderFromEntries(value: boolean): void {\n" +
      "    renderFromEntries.value = value;\n" +
      "  }\n\n" +
      "  /**\n" +
      "   * 灌入启动迁移得到的持久化线程快照（见 7.5c 接线）。\n" +
      "   * 换库语义：替换整组线程并重置去重集；activeThreadId 由调用方传入\n" +
      "   * （通常为 7.5a resolver 归一后的活动线程 id）。同步 kick 活动线程指针恢复，\n" +
      "   * 覆盖「同 id 换库」watch 不触发的情形（去重保证不与 watch 重复恢复）。\n" +
      "   */\n" +
      "  function setPersistedThreads(threads: IAiThread[], activeThreadId: string | null): void {\n" +
      "    restoredThreadIds.clear();\n" +
      "    persistedThreads.value = threads;\n" +
      "    persistedActiveThreadId.value = activeThreadId;\n" +
      "    if (activeThreadId) void restorePersistedThreadPointers(activeThreadId);\n" +
      "  }\n\n" +
      "  /** 切换活动持久化线程（触发指针惰性恢复 watch）。 */\n" +
      "  function setPersistedActiveThreadId(activeThreadId: string | null): void {\n" +
      "    persistedActiveThreadId.value = activeThreadId;\n" +
      "  }\n\n" +
      "  return {",
  },
  {
    name: 'export persisted state/getter/actions',
    find:
      "  return {\n" +
      "    // state\n" +
      "    renderFromEntries,\n" +
      "    liveThread,\n" +
      "    // getters\n" +
      "    projectedActiveThread,\n" +
      "    activeThread,\n" +
      "    activeEntries,\n" +
      "    // actions\n" +
      "    setLiveThread,\n" +
      "    setRenderFromEntries,\n" +
      "  };",
    replace:
      "  return {\n" +
      "    // state\n" +
      "    renderFromEntries,\n" +
      "    liveThread,\n" +
      "    persistedThreads,\n" +
      "    persistedActiveThreadId,\n" +
      "    // getters\n" +
      "    projectedActiveThread,\n" +
      "    persistedActiveThread,\n" +
      "    activeThread,\n" +
      "    activeEntries,\n" +
      "    // actions\n" +
      "    setLiveThread,\n" +
      "    setRenderFromEntries,\n" +
      "    setPersistedThreads,\n" +
      "    setPersistedActiveThreadId,\n" +
      "  };",
  },
];

const SPEC_CONTENT = `import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import type { IAiThread } from '@/types/ai/thread';

// 隔离持久化读路径：legacy 投影置空 (activeThread=null)；指针恢复注入假实现。
const { restoreMock } = vi.hoisted(() => ({ restoreMock: vi.fn() }));

vi.mock('@/store/aiConversation', () => ({
  useAiConversationStore: () => ({ activeThread: null }),
}));
vi.mock('@/store/plugins/debouncedPersistStorage', () => ({
  restoreAttachmentPreviewPointers: (value: unknown) => restoreMock(value),
}));

type UseAiThreadStore = typeof import('@/store/aiThread')['useAiThreadStore'];
let useAiThreadStore: UseAiThreadStore;

const makeThread = (id: string, title = id): IAiThread =>
  ({ id, title, entries: [] } as unknown as IAiThread);

// 冲刷 watcher(nextTick) 与异步恢复(微任务链)。
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await nextTick();
    await Promise.resolve();
  }
};

beforeEach(async () => {
  setActivePinia(createPinia());
  restoreMock.mockReset();
  restoreMock.mockImplementation(async (value: unknown) => ({ changed: false, value }));
  ({ useAiThreadStore } = await import('@/store/aiThread'));
});

describe('aiThread store — 7.5b 持久化读路径', () => {
  it('activeThread 优先级 live > persisted > projected', async () => {
    const store = useAiThreadStore();
    expect(store.activeThread).toBeNull(); // projected 为 null（mock）

    store.setPersistedThreads([makeThread('a'), makeThread('b')], 'b');
    await flush();
    expect(store.persistedActiveThread?.id).toBe('b');
    expect(store.activeThread?.id).toBe('b');

    store.setLiveThread(makeThread('live'));
    expect(store.activeThread?.id).toBe('live');

    store.setLiveThread(null);
    expect(store.activeThread?.id).toBe('b');
  });

  it('persistedActiveThread 按 id 解析；空/不存在 → null', async () => {
    const store = useAiThreadStore();
    store.setPersistedThreads([makeThread('a'), makeThread('b')], null);
    await flush();
    expect(store.persistedActiveThread).toBeNull();

    store.setPersistedActiveThreadId('zzz');
    await flush();
    expect(store.persistedActiveThread).toBeNull();

    store.setPersistedActiveThreadId('a');
    await flush();
    expect(store.persistedActiveThread?.id).toBe('a');
  });

  it('换库 + 切换线程惰性恢复指针，且每线程仅恢复一次', async () => {
    restoreMock.mockImplementation(async (value: { title?: string }) => ({
      changed: true,
      value: { ...value, title: 'RESTORED' },
    }));

    const store = useAiThreadStore();
    store.setPersistedThreads([makeThread('a'), makeThread('b')], 'a');
    await flush();

    expect(restoreMock).toHaveBeenCalledTimes(1); // 仅活动线程 'a'
    expect(store.persistedThreads.find((t) => t.id === 'a')?.title).toBe('RESTORED');
    expect(store.persistedThreads.find((t) => t.id === 'b')?.title).toBe('b');

    store.setPersistedActiveThreadId('b');
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(2);
    expect(store.persistedThreads.find((t) => t.id === 'b')?.title).toBe('RESTORED');

    store.setPersistedActiveThreadId('a'); // 已恢复 → 不再调用
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });

  it('changed:false 时不替换数组（保持对象身份）', async () => {
    const store = useAiThreadStore();
    const a = makeThread('a');
    store.setPersistedThreads([a], 'a');
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(1);
    expect(store.persistedThreads[0]).toBe(a);
  });

  it('setPersistedThreads 重置去重集：同 id 换库后再次恢复', async () => {
    restoreMock.mockImplementation(async (value: { title?: string }) => ({
      changed: true,
      value: { ...value, title: 'RESTORED' },
    }));
    const store = useAiThreadStore();

    store.setPersistedThreads([makeThread('a')], 'a');
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(1);

    store.setPersistedThreads([makeThread('a')], 'a'); // 新对象、同 id
    await flush();
    expect(restoreMock).toHaveBeenCalledTimes(2);
  });
});
`;

const applyEdits = () => {
  const abs = join(REPO_ROOT, STORE);
  if (!existsSync(abs)) fail(`缺少 ${STORE}。`);
  let content = readFileSync(abs, 'utf8');

  if (content.includes(STORE_SENTINEL)) {
    log(`✓ ${STORE} 已含 '${STORE_SENTINEL}'，跳过编辑（幂等）。`);
    return;
  }

  for (const { name, find, replace } of EDITS) {
    const n = content.split(find).length - 1;
    if (n !== 1) fail(`[${name}] 锚点预期 1 次，实际 ${n} 次；中止（未写入）。`);
    content = content.replace(find, () => replace);
  }

  if (CHECK) {
    log(`  [将修改] ${STORE}（应用 ${EDITS.length} 处编辑）`);
    return;
  }
  writeFileSync(abs, content, { encoding: 'utf8' });
  log('  ✓ 写入', STORE);
};

const createSpec = () => {
  const abs = join(REPO_ROOT, SPEC);
  if (existsSync(abs) && !FORCE) {
    log(`✓ ${SPEC} 已存在，跳过创建（用 --force 覆盖）。`);
    return;
  }
  if (CHECK) {
    log(`  [将创建] ${SPEC}（${SPEC_CONTENT.length} bytes）`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, SPEC_CONTENT, { encoding: 'utf8' });
  log('  ✓ 写入', SPEC);
};

const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : FORCE ? '模式: 写入(--force)' : '模式: 写入');
  applyEdits();
  createSpec();
  log('✓ 完成。下一步: pnpm typecheck && pnpm lint && pnpm test');
};

run();