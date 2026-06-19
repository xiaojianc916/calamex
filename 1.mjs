#!/usr/bin/env node
// scripts/codemod/step7-5c-wire-persisted-read.mjs
//
// 7.5c — 启动接线：把 entries 新 key 读路径接入引导流程（Step 7 双读回退）。
//
// 依赖（硬前置，缺则拒绝）：
//   - 7.5a: src/store/aiThread/entriesRenderHydrate.ts 含 hydrateAiThreadEntriesForRender
//   - 7.5b: src/store/aiThread/index.ts 含 setPersistedThreads / setPersistedActiveThreadId
//
// 1) CREATE src/store/aiThread/startupPersistedReadWiring.ts（+ spec）
// 2) EDIT  src/app/main.ts：hydrateAiConversationAfterBootstrap 内，legacy hydrate 完成后
//          动态 import 并调用 installAiThreadPersistedReadWiring。
//
// 幂等：main.ts 若已含 'startupPersistedReadWiring' 则跳过编辑；spec/wiring 已存在则跳过创建（除非 --force）。
//
// 用法：
//   node scripts/codemod/step7-5c-wire-persisted-read.mjs --check
//   node scripts/codemod/step7-5c-wire-persisted-read.mjs
//   node scripts/codemod/step7-5c-wire-persisted-read.mjs --force
//   REPO_ROOT=/path node scripts/codemod/step7-5c-wire-persisted-read.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const ARGS = new Set(process.argv.slice(2));
const CHECK = ARGS.has('--check');
const FORCE = ARGS.has('--force');

const log = (...a) => console.log('[step7-5c]', ...a);
const fail = (msg) => {
  console.error('[step7-5c] ✗', msg);
  process.exit(1);
};

const MAIN = 'src/app/main.ts';
const WIRING = 'src/store/aiThread/startupPersistedReadWiring.ts';
const SPEC = 'src/store/aiThread/startupPersistedReadWiring.spec.ts';
const MAIN_SENTINEL = 'startupPersistedReadWiring';

// ---- 前置校验 ---------------------------------------------------------------
const assertPreconditions = () => {
  const checks = [
    { file: 'src/store/aiThread/entriesRenderHydrate.ts', token: 'hydrateAiThreadEntriesForRender', step: '7.5a' },
    { file: 'src/store/aiThread/index.ts', token: 'setPersistedThreads', step: '7.5b' },
    { file: 'src/store/aiThread/index.ts', token: 'setPersistedActiveThreadId', step: '7.5b' },
  ];
  for (const { file, token, step } of checks) {
    const abs = join(REPO_ROOT, file);
    if (!existsSync(abs)) fail(`前置缺失：${file} 不存在（请先应用 ${step}）。`);
    if (!readFileSync(abs, 'utf8').includes(token)) {
      fail(`前置缺失：${file} 未含 '${token}'（请先应用 ${step}）。`);
    }
  }
  log('✓ 前置校验通过（7.5a + 7.5b 已就位）。');
};

// ---- main.ts 锚点编辑 -------------------------------------------------------
const MAIN_FIND =
  "        void hydrateAiConversationStorage().catch((error: unknown) => {\n" +
  "          console.warn('AI 会话历史后台 hydrate 失败', error);\n" +
  "        });";
const MAIN_REPLACE =
  "        void hydrateAiConversationStorage()\n" +
  "          .then(async () => {\n" +
  "            // legacy hydrate 完成后再读新 entries key（Step 7 双读回退接线）。\n" +
  "            const { installAiThreadPersistedReadWiring } = await import(\n" +
  "              '@/store/aiThread/startupPersistedReadWiring'\n" +
  "            );\n" +
  "            await installAiThreadPersistedReadWiring();\n" +
  "          })\n" +
  "          .catch((error: unknown) => {\n" +
  "            console.warn('AI 会话历史后台 hydrate 失败', error);\n" +
  "          });";

const WIRING_CONTENT = `/* ============================================================================
 * 启动迁移读侧接线（Step 7：双读回退）
 *
 * legacy hydrate 完成后：
 *   1) 以旧 conversation 当前线程作为 legacy 回退输入；
 *   2) 调 7.5a hydrateAiThreadEntriesForRender 读新 entries key（含活动线程指针惰性恢复）+ resolver；
 *   3) 灌入 aiThread.setPersistedThreads，作为 projectedActiveThread 之下的回退源；
 *   4) 监听活动线程切换，同步 persistedActiveThreadId（驱动 7.5b 指针惰性恢复，保持回退源活动对齐）。
 *
 * 优先级约定（见 aiThread store）：liveThread ?? projectedActiveThread ?? persistedActiveThread。
 * 即 persisted 仅作回退：双轨期渲染仍以 legacy 投影为准（计划 Step 6），persisted 用于
 * 迁移失败/空 legacy 时不致空白，并为 Step 8 切换 SoT 预备。
 * ========================================================================== */
import { watch } from 'vue';

import { useAiConversationStore } from '@/store/aiConversation';
import { useAiThreadStore } from '@/store/aiThread';
import { hydrateAiThreadEntriesForRender } from '@/store/aiThread/entriesRenderHydrate';

export interface IInstallPersistedReadWiringDeps {
  hydrateForRender: typeof hydrateAiThreadEntriesForRender;
}

const defaultDeps: IInstallPersistedReadWiringDeps = {
  hydrateForRender: hydrateAiThreadEntriesForRender,
};

/**
 * 安装 entries 新 key 的启动读接线。须在 pinia 就位、legacy hydrate 完成后调用。
 * deps 可注入以便单测（不 mock 模块）。
 */
export async function installAiThreadPersistedReadWiring(
  deps: IInstallPersistedReadWiringDeps = defaultDeps,
): Promise<void> {
  const conversation = useAiConversationStore();
  const aiThread = useAiThreadStore();

  // 活动线程切换 → 同步回退源活动 id（含指针惰性恢复）；immediate 立即对齐当前值。
  watch(
    () => conversation.activeThreadId,
    (id) => {
      aiThread.setPersistedActiveThreadId(id ?? null);
    },
    { immediate: true },
  );

  const resolved = await deps.hydrateForRender({
    legacyActiveThreadId: conversation.activeThreadId ?? null,
    legacyThreads: conversation.threads,
  });

  aiThread.setPersistedThreads(resolved.threads, resolved.activeThreadId);
}
`;

const SPEC_CONTENT = `import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';

const mocks = vi.hoisted(() => ({
  conversation: { activeThreadId: 'a' as string | null, threads: [] as unknown[] },
  setPersistedThreads: vi.fn(),
  setPersistedActiveThreadId: vi.fn(),
}));

vi.mock('@/store/aiConversation', () => ({
  useAiConversationStore: () => mocks.conversation,
}));
vi.mock('@/store/aiThread', () => ({
  useAiThreadStore: () => ({
    setPersistedThreads: mocks.setPersistedThreads,
    setPersistedActiveThreadId: mocks.setPersistedActiveThreadId,
  }),
}));

type Install = typeof import('@/store/aiThread/startupPersistedReadWiring')['installAiThreadPersistedReadWiring'];
let installAiThreadPersistedReadWiring: Install;

beforeEach(async () => {
  mocks.conversation = reactive({ activeThreadId: 'a', threads: [{ id: 'a' }] });
  mocks.setPersistedThreads.mockReset();
  mocks.setPersistedActiveThreadId.mockReset();
  ({ installAiThreadPersistedReadWiring } = await import(
    '@/store/aiThread/startupPersistedReadWiring'
  ));
});

describe('startupPersistedReadWiring — 7.5c', () => {
  it('读 legacy 输入 → hydrateForRender → 灌入 setPersistedThreads', async () => {
    const hydrateForRender = vi
      .fn()
      .mockResolvedValue({ source: 'entries', activeThreadId: 'a', threads: [{ id: 'a' }] });

    await installAiThreadPersistedReadWiring({ hydrateForRender });

    expect(hydrateForRender).toHaveBeenCalledWith({
      legacyActiveThreadId: 'a',
      legacyThreads: [{ id: 'a' }],
    });
    expect(mocks.setPersistedThreads).toHaveBeenCalledWith([{ id: 'a' }], 'a');
  });

  it('活动线程切换同步 persistedActiveThreadId（immediate + 后续切换）', async () => {
    const hydrateForRender = vi
      .fn()
      .mockResolvedValue({ source: 'legacy', activeThreadId: 'a', threads: [] });

    await installAiThreadPersistedReadWiring({ hydrateForRender });
    expect(mocks.setPersistedActiveThreadId).toHaveBeenCalledWith('a'); // immediate

    mocks.setPersistedActiveThreadId.mockClear();
    mocks.conversation.activeThreadId = 'b';
    await nextTick();
    expect(mocks.setPersistedActiveThreadId).toHaveBeenCalledWith('b');
  });
});
`;

const editMain = () => {
  const abs = join(REPO_ROOT, MAIN);
  if (!existsSync(abs)) fail(`缺少 ${MAIN}。`);
  const before = readFileSync(abs, 'utf8');
  if (before.includes(MAIN_SENTINEL)) {
    log(`✓ ${MAIN} 已含 '${MAIN_SENTINEL}'，跳过编辑（幂等）。`);
    return;
  }
  const n = before.split(MAIN_FIND).length - 1;
  if (n !== 1) fail(`${MAIN} 锚点预期 1 次，实际 ${n} 次；中止。`);
  const next = before.replace(MAIN_FIND, () => MAIN_REPLACE);
  if (CHECK) {
    log(`  [将修改] ${MAIN}`);
    return;
  }
  writeFileSync(abs, next, { encoding: 'utf8' });
  log('  ✓ 写入', MAIN);
};

const createFile = (relPath, content) => {
  const abs = join(REPO_ROOT, relPath);
  if (existsSync(abs) && !FORCE) {
    log(`✓ ${relPath} 已存在，跳过创建（用 --force 覆盖）。`);
    return;
  }
  if (CHECK) {
    log(`  [将创建] ${relPath}（${content.length} bytes）`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, { encoding: 'utf8' });
  log('  ✓ 写入', relPath);
};

const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : FORCE ? '模式: 写入(--force)' : '模式: 写入');
  assertPreconditions();
  createFile(WIRING, WIRING_CONTENT);
  createFile(SPEC, SPEC_CONTENT);
  editMain();
  log('✓ 完成。下一步: pnpm typecheck && pnpm lint && pnpm test');
};

run();