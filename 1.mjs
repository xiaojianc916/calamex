#!/usr/bin/env node
// scripts/codemod/step7-4c-entries-mirror-bridge.mjs
//
// Step 7.4c —— entries 双写桥接逻辑 (依赖注入, 未接线, 零运行时变化)
//
// 新建:
//   src/store/aiThread/entriesMirrorBridge.ts        投影双写 + 订阅装载 + hydrate 读自检
//   src/store/aiThread/entriesMirrorBridge.spec.ts   单测 (假 store + 注入假 deps)
//
// 逻辑全部经依赖注入, 默认指向真实单例; 真实接线留待 7.4d (改 main.ts)。
// 未被 main.ts / barrel 引用 → 零运行时变化, 可回退。
//
// 依赖前置 (缺失即提前失败, 零写入):
//   - 7.3:  src/store/aiThread/hydrate.ts          含 resolvePersistedThreads / IResolvedPersistedThreads
//   - 7.4a: src/store/aiThread/project.ts          含 projectConversationToThreadPersist
//   - 7.4b: src/store/plugins/aiThreadEntriesStorage.ts  含 scheduleAiThreadEntriesPersist / hydrateAiThreadEntriesSnapshot
//   - main: src/store/aiConversation.ts            含 IAiConversationThread
//
// 用法:
//   node scripts/codemod/step7-4c-entries-mirror-bridge.mjs --check
//   node scripts/codemod/step7-4c-entries-mirror-bridge.mjs
//   node scripts/codemod/step7-4c-entries-mirror-bridge.mjs --force
//   REPO_ROOT=/path node scripts/codemod/step7-4c-entries-mirror-bridge.mjs

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const argv = new Set(process.argv.slice(2));
const CHECK = argv.has('--check');
const FORCE = argv.has('--force');

const log = (...a) => console.log('[step7-4c]', ...a);
const fail = (msg) => {
  console.error('[step7-4c] ✗', msg);
  process.exit(1);
};

const PRECONDITIONS = [
  {
    path: 'src/store/aiThread/hydrate.ts',
    tokens: ['resolvePersistedThreads', 'IResolvedPersistedThreads'],
    hint: '请先应用 step7-3-hydrate-resolver.mjs (7.3)。',
  },
  {
    path: 'src/store/aiThread/project.ts',
    tokens: ['projectConversationToThreadPersist'],
    hint: '请先应用 step7-4a-project-conversation.mjs (7.4a)。',
  },
  {
    path: 'src/store/plugins/aiThreadEntriesStorage.ts',
    tokens: ['scheduleAiThreadEntriesPersist', 'hydrateAiThreadEntriesSnapshot'],
    hint: '请先应用 step7-4b-entries-mirror-storage.mjs (7.4b)。',
  },
  {
    path: 'src/store/aiConversation.ts',
    tokens: ['IAiConversationThread'],
    hint: 'aiConversation.ts 与预期 main 不符。',
  },
];

const checkPreconditions = () => {
  const errors = [];
  for (const pc of PRECONDITIONS) {
    const abs = join(REPO_ROOT, pc.path);
    if (!existsSync(abs)) {
      errors.push(`缺少依赖文件 ${pc.path} —— ${pc.hint}`);
      continue;
    }
    const content = readFileSync(abs, 'utf8');
    for (const token of pc.tokens) {
      if (!content.includes(token)) {
        errors.push(`${pc.path} 未包含 "${token}" —— ${pc.hint}`);
      }
    }
  }
  return errors;
};

const BRIDGE_TS = `import type { IAiConversationThread } from '@/store/aiConversation';
import { resolvePersistedThreads, type IResolvedPersistedThreads } from '@/store/aiThread/hydrate';
import { projectConversationToThreadPersist } from '@/store/aiThread/project';
import {
  hydrateAiThreadEntriesSnapshot,
  scheduleAiThreadEntriesPersist,
} from '@/store/plugins/aiThreadEntriesStorage';

/**
 * entries 双写桥接 (Step 7.4c)。
 *
 * 把 legacy 会话 store 与新 entries 镜像引擎/读 resolver 接起来, 但不在此处改变
 * 渲染 SoT (legacy 仍是显示来源)。所有外部副作用经 deps 注入, 默认指向真实单例,
 * 便于单测且与具体实现解耦。真实接线 (main.ts) 留待 7.4d; 本模块当前未被引用。
 */

/** 桥所需的会话 store 最小形状 (便于注入假 store 测试)。 */
export interface IConversationStoreLike {
  activeThreadId: string | null;
  threads: IAiConversationThread[];
  $subscribe: (callback: () => void) => unknown;
}

/** 可注入副作用 (默认绑定真实镜像引擎)。 */
export interface IEntriesMirrorDeps {
  schedulePersist: (value: string) => void;
  hydrateSnapshot: () => Promise<{ raw: string | null }>;
}

const defaultDeps: IEntriesMirrorDeps = {
  schedulePersist: scheduleAiThreadEntriesPersist,
  hydrateSnapshot: hydrateAiThreadEntriesSnapshot,
};

const parseRawEntriesSnapshot = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
};

/** 投影当前 store 状态为 entries 快照并入双写队列。 */
export const mirrorConversationToEntries = (
  store: IConversationStoreLike,
  deps: IEntriesMirrorDeps = defaultDeps,
): void => {
  const snapshot = projectConversationToThreadPersist({
    activeThreadId: store.activeThreadId,
    threads: store.threads,
  });
  deps.schedulePersist(JSON.stringify(snapshot));
};

/**
 * 读取新 key 快照并经 7.3 resolver 解析 (读路径自检)。
 * 新 key 有效 → source 'entries'; 否则回退到 legacy 投影。结果供 7.4d/7.5 接入,
 * 当前不改变渲染 SoT。
 */
export const resolveMirrorOnHydrate = async (
  store: IConversationStoreLike,
  deps: IEntriesMirrorDeps = defaultDeps,
): Promise<IResolvedPersistedThreads> => {
  const { raw } = await deps.hydrateSnapshot();
  return resolvePersistedThreads({
    rawEntriesSnapshot: parseRawEntriesSnapshot(raw),
    legacyActiveThreadId: store.activeThreadId,
    legacyThreads: store.threads,
  });
};

/**
 * 安装双写镜像: 立即镜像一次当前状态, 并订阅后续 store 变更继续镜像。
 * 返回取消订阅句柄 (供卸载/回退)。
 */
export const installEntriesMirror = (
  store: IConversationStoreLike,
  deps: IEntriesMirrorDeps = defaultDeps,
): (() => void) => {
  mirrorConversationToEntries(store, deps);
  const stop = store.$subscribe(() => {
    mirrorConversationToEntries(store, deps);
  });
  return typeof stop === 'function' ? (stop as () => void) : () => {};
};
`;

const BRIDGE_SPEC_TS = `import { describe, expect, it } from 'vitest';
import type { IAiConversationThread } from '@/store/aiConversation';
import {
  installEntriesMirror,
  mirrorConversationToEntries,
  resolveMirrorOnHydrate,
  type IConversationStoreLike,
  type IEntriesMirrorDeps,
} from '@/store/aiThread/entriesMirrorBridge';
import { projectConversationToThreadPersist } from '@/store/aiThread/project';

const makeLegacyThread = (id: string): IAiConversationThread =>
  ({
    id,
    title: 'T-' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  }) as unknown as IAiConversationThread;

const makeStore = (
  threads: IAiConversationThread[],
  activeThreadId: string | null,
): IConversationStoreLike & { fire: () => void } => {
  let cb: (() => void) | null = null;
  return {
    activeThreadId,
    threads,
    $subscribe: (callback: () => void) => {
      cb = callback;
      return () => {
        cb = null;
      };
    },
    fire: () => cb?.(),
  };
};

const makeDeps = () => {
  const scheduled: string[] = [];
  let raw: string | null = null;
  const deps: IEntriesMirrorDeps = {
    schedulePersist: (value: string) => {
      scheduled.push(value);
    },
    hydrateSnapshot: async () => ({ raw }),
  };
  return {
    deps,
    scheduled,
    setRaw: (value: string | null) => {
      raw = value;
    },
  };
};

describe('entriesMirrorBridge', () => {
  it('mirrorConversationToEntries 投影当前状态并入双写队列', () => {
    const { deps, scheduled } = makeDeps();
    const store = makeStore([makeLegacyThread('a'), makeLegacyThread('b')], 'b');
    mirrorConversationToEntries(store, deps);
    expect(scheduled).toHaveLength(1);
    const snapshot = JSON.parse(scheduled[0]) as {
      activeThreadId: string;
      threads: { id: string }[];
    };
    expect(snapshot.activeThreadId).toBe('b');
    expect(snapshot.threads.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('installEntriesMirror 立即镜像一次, 订阅触发后再次镜像, stop 后停止', () => {
    const { deps, scheduled } = makeDeps();
    const store = makeStore([makeLegacyThread('a')], 'a');
    const stop = installEntriesMirror(store, deps);
    expect(scheduled).toHaveLength(1);
    store.fire();
    expect(scheduled).toHaveLength(2);
    stop();
    store.fire();
    expect(scheduled).toHaveLength(2);
  });

  it('resolveMirrorOnHydrate: 新 key 有效 → source entries', async () => {
    const { deps, setRaw } = makeDeps();
    const store = makeStore([makeLegacyThread('a'), makeLegacyThread('b')], 'a');
    const projected = projectConversationToThreadPersist({
      activeThreadId: 'a',
      threads: [makeLegacyThread('a'), makeLegacyThread('b')],
    });
    setRaw(JSON.stringify(projected));
    const resolved = await resolveMirrorOnHydrate(store, deps);
    expect(resolved.source).toBe('entries');
    expect(resolved.threads.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('resolveMirrorOnHydrate: 新 key 为空 → 回退 legacy', async () => {
    const { deps, setRaw } = makeDeps();
    setRaw(null);
    const store = makeStore([makeLegacyThread('x')], 'x');
    const resolved = await resolveMirrorOnHydrate(store, deps);
    expect(resolved.source).toBe('legacy');
    expect(resolved.threads.map((t) => t.id)).toEqual(['x']);
  });
});
`;

const FILES = [
  { path: 'src/store/aiThread/entriesMirrorBridge.ts', content: BRIDGE_TS },
  { path: 'src/store/aiThread/entriesMirrorBridge.spec.ts', content: BRIDGE_SPEC_TS },
];

const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : FORCE ? '模式: 写入 (--force 覆盖)' : '模式: 写入');

  const preErrors = checkPreconditions();
  if (preErrors.length > 0) {
    preErrors.forEach((e) => console.error('[step7-4c] ✗ 前置:', e));
    fail('依赖前置校验失败, 未写入任何文件。');
  }
  log('✓ 依赖前置校验通过 (7.3 / 7.4a / 7.4b / aiConversation)');

  const conflicts = FILES.filter((f) => existsSync(join(REPO_ROOT, f.path)));
  if (conflicts.length > 0 && !FORCE) {
    conflicts.forEach((f) => console.error('[step7-4c] ✗ 目标已存在:', f.path));
    fail('目标文件已存在; 用 --force 覆盖, 或先清理。未写入任何文件。');
  }

  if (CHECK) {
    FILES.forEach((f) => {
      const state = existsSync(join(REPO_ROOT, f.path)) ? '将覆盖' : '将创建';
      log(`  [${state}] ${f.path} (${f.content.length} bytes)`);
    });
    log('✓ --check 通过, 未写入。');
    return;
  }

  for (const f of FILES) {
    const abs = join(REPO_ROOT, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, { encoding: 'utf8' });
    log('  ✓ 写入', f.path);
  }
  log('✓ 完成。下一步: pnpm typecheck && pnpm lint && pnpm test');
};

run();