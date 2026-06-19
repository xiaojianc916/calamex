#!/usr/bin/env node
/* step7-5c-wire-persisted-read.mjs
 * ADR-0014 Step 7.5c —— 启动持久化读侧接线。
 *   新建 startupPersistedReadWiring.ts(+spec)：读旧 key 已 hydrate 的 legacy 快照
 *   -> 7.5a 组合器归一 entries -> 灌入 aiThread store 持久化回退槽(7.5b)。
 *   编辑 src/app/main.ts：在后台 hydrateAiConversationStorage() 完成后链式触发。
 * CREATE 默认拒绝覆盖(--force)；main.ts 编辑幂等(已接线则跳过)；--check 干跑；事务化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');
const tag = '[step7-5c]';
const log = (m) => console.log(tag + ' ' + m);
const die = (m) => { console.error(tag + ' ✗ ' + m); process.exit(1); };

log('REPO_ROOT = ' + REPO_ROOT);
log('模式: ' + (CHECK ? '检查' : '写入') + (FORCE ? '（--force 覆盖）' : ''));

const read = (rel) => {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) die('前置缺失：' + rel + ' 不存在。');
  return readFileSync(abs, 'utf8');
};
const requireToken = (rel, token) => {
  if (!read(rel).includes(token)) die('前置缺失：' + rel + ' 未找到 ' + token + '（请先应用上游步骤）。');
};

// ---- 前置：跨文件契约 ----
requireToken('src/store/aiThread/entriesRenderHydrate.ts', 'export async function hydrateAiThreadEntriesForRender');
requireToken('src/store/aiThread/index.ts', 'setPersistedThreads');

const SOURCE = `/* ============================================================================
 * 启动持久化读侧接线（ADR-0014 Step 7.5c）
 *
 * 在启动后台 hydrate（旧 aiConversation key）完成后，再读新 entries key 并经
 * 7.5a 组合器归一，把结果灌入 aiThread store 的持久化回退槽（7.5b）。
 *
 * 顺序约束：必须在 hydrateAiConversationStorage() 之后调用，确保 legacy 回退源
 * （conversation.threads / activeThreadId）已就位；entries key 为空/损坏时，
 * 7.5a 会回退到这些 legacy 线程，保证「迁移失败不致空白」。
 *
 * 依赖注入：默认 deps 在调用时惰性取 store（需 pinia 已安装）；单测注入假 deps，
 * 无需 pinia / 真实存储。
 * ========================================================================== */
import { useAiConversationStore } from '@/store/aiConversation';
import { useAiThreadStore } from '@/store/aiThread';
import {
  hydrateAiThreadEntriesForRender,
  type IHydrateAiThreadEntriesForRenderInput,
} from '@/store/aiThread/entriesRenderHydrate';
import type { IResolvedPersistedThreads } from '@/store/aiThread/hydrate';
import type { IAiThread } from '@/types/ai/thread';

export interface IRunStartupPersistedReadDeps {
  /** 取旧 key 已 hydrate 的活动线程 id 与线程列表（entries 缺失时的回退源）。 */
  readLegacy: () => IHydrateAiThreadEntriesForRenderInput;
  /** 7.5a 组合器：读新 key 快照 -> 归一 -> 活动线程指针恢复。 */
  hydrateForRender: (
    input: IHydrateAiThreadEntriesForRenderInput,
  ) => Promise<IResolvedPersistedThreads>;
  /** 把归一结果灌入 aiThread store 持久化回退槽。 */
  applyPersisted: (threads: IAiThread[], activeThreadId: string | null) => void;
}

const defaultDeps: IRunStartupPersistedReadDeps = {
  readLegacy: () => {
    const conversation = useAiConversationStore();
    return {
      legacyActiveThreadId: conversation.activeThreadId,
      legacyThreads: conversation.threads,
    };
  },
  hydrateForRender: hydrateAiThreadEntriesForRender,
  applyPersisted: (threads, activeThreadId) => {
    useAiThreadStore().setPersistedThreads(threads, activeThreadId);
  },
};

/**
 * 执行一次启动持久化读：legacy 快照 -> entries 归一 -> 灌入回退槽。
 * 抛错交由调用方（main.ts 后台 hydrate 链）统一吞掉并告警，不阻断启动。
 */
export async function runStartupPersistedRead(
  deps: IRunStartupPersistedReadDeps = defaultDeps,
): Promise<void> {
  const { legacyActiveThreadId, legacyThreads } = deps.readLegacy();
  const resolved = await deps.hydrateForRender({ legacyActiveThreadId, legacyThreads });
  deps.applyPersisted(resolved.threads, resolved.activeThreadId);
}
`;

const SPEC = `import { describe, expect, it } from 'vitest';

import type { IAiConversationThread } from '@/store/aiConversation';
import type { IHydrateAiThreadEntriesForRenderInput } from '@/store/aiThread/entriesRenderHydrate';
import type { IResolvedPersistedThreads } from '@/store/aiThread/hydrate';
import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';
import type { IAiThread } from '@/types/ai/thread';

function makeThread(id: string): IAiThread {
  return {
    id,
    title: 'Thread ' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    entries: [],
  };
}

describe('runStartupPersistedRead', () => {
  it('把 legacy 快照透传给 7.5a 组合器，并灌入归一结果', async () => {
    const legacyThreads: IAiConversationThread[] = [];
    let hydrateInput: IHydrateAiThreadEntriesForRenderInput | null = null;
    const applied: Array<{ threads: IAiThread[]; activeThreadId: string | null }> = [];
    const resolved: IResolvedPersistedThreads = {
      source: 'entries',
      activeThreadId: 't1',
      threads: [makeThread('t1')],
    };

    await runStartupPersistedRead({
      readLegacy: () => ({ legacyActiveThreadId: 'leg-1', legacyThreads }),
      hydrateForRender: async (input) => {
        hydrateInput = input;
        return resolved;
      },
      applyPersisted: (threads, activeThreadId) => {
        applied.push({ threads, activeThreadId });
      },
    });

    expect(hydrateInput).toEqual({ legacyActiveThreadId: 'leg-1', legacyThreads });
    expect(applied).toEqual([{ threads: resolved.threads, activeThreadId: 't1' }]);
  });

  it('先读 legacy 再 hydrate 再灌入，且只灌一次', async () => {
    const order: string[] = [];
    const resolved: IResolvedPersistedThreads = { source: 'empty', activeThreadId: null, threads: [] };

    await runStartupPersistedRead({
      readLegacy: () => {
        order.push('read');
        return { legacyActiveThreadId: null, legacyThreads: [] };
      },
      hydrateForRender: async () => {
        order.push('hydrate');
        return resolved;
      },
      applyPersisted: () => {
        order.push('apply');
      },
    });

    expect(order).toEqual(['read', 'hydrate', 'apply']);
  });
});
`;

const createFiles = [
  { path: 'src/store/aiThread/startupPersistedReadWiring.ts', content: SOURCE },
  { path: 'src/store/aiThread/startupPersistedReadWiring.spec.ts', content: SPEC },
];
for (const f of createFiles) {
  if (existsSync(join(REPO_ROOT, f.path)) && !FORCE) {
    die('目标已存在：' + f.path + '（如确需覆盖请加 --force）。');
  }
}

// ---- main.ts 幂等编辑 ----
const MAIN_REL = 'src/app/main.ts';
let main = read(MAIN_REL);
const alreadyWired = main.includes('runStartupPersistedRead');

const IMPORT_FIND =
  "import { pinia } from '@/store';\n" +
  "import { hydrateAiConversationStorage } from '@/store/plugins/debouncedPersistStorage';";
const IMPORT_REPLACE =
  "import { pinia } from '@/store';\n" +
  "import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';\n" +
  "import { hydrateAiConversationStorage } from '@/store/plugins/debouncedPersistStorage';";

const BODY_FIND =
  "        void hydrateAiConversationStorage().catch((error: unknown) => {\n" +
  "          console.warn('AI 会话历史后台 hydrate 失败', error);\n" +
  "        });";
const BODY_REPLACE =
  "        void hydrateAiConversationStorage()\n" +
  "          .then(() => runStartupPersistedRead())\n" +
  "          .catch((error: unknown) => {\n" +
  "            console.warn('AI 会话历史后台 hydrate 失败', error);\n" +
  "          });";

const applyEdit = (content, find, replace, label) => {
  const n = content.split(find).length - 1;
  if (n !== 1) die('main.ts 锚点【' + label + '】期望命中 1 次，实际 ' + n + ' 次。');
  return content.replace(find, () => replace);
};

if (alreadyWired) {
  log('· main.ts 已接线 runStartupPersistedRead，跳过编辑。');
} else {
  main = applyEdit(main, IMPORT_FIND, IMPORT_REPLACE, 'import');
  main = applyEdit(main, BODY_FIND, BODY_REPLACE, 'hydrate-chain');
}

if (CHECK) {
  log('✓ 检查通过：将创建 ' + createFiles.map((f) => f.path).join(', ') +
    (alreadyWired ? '；main.ts 无需改动。' : '；并编辑 ' + MAIN_REL + '。'));
  process.exit(0);
}

for (const f of createFiles) {
  const abs = join(REPO_ROOT, f.path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, f.content, 'utf8');
  log('✓ 写入 ' + f.path);
}
if (!alreadyWired) {
  writeFileSync(join(REPO_ROOT, MAIN_REL), main, 'utf8');
  log('✓ 编辑 ' + MAIN_REL);
}
log('✓ 完成。');