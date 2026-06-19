// Step 8 slice 1（修订）：删除被 7.5 读接线取代的死函数 resolveMirrorOnHydrate
// 及其级联死代码 + 对应 spec 用例。
//
// ⚠️ 原计划同时删 src/types/ai/conversation.schema.ts，经核查它不是死代码：
//    src/store/aiConversation.ts 的 persist.afterHydrate 仍在用它做线上 hydrate 校验/救援。
//    故本刀不动它，留待“清退 legacy key shell-ide.ai-conversation”那一刀。
//
// 用法：
//   node 1.mjs           应用
//   node 1.mjs --check   dry-run（只打印，不落盘）
//   REPO_ROOT=/path node 1.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK = process.argv.includes('--check');
const rel = (p) => join(REPO_ROOT, p);

let changed = 0;
let skipped = 0;

const read = (p) => {
  const abs = rel(p);
  if (!existsSync(abs)) throw new Error(`找不到文件：${p}`);
  return readFileSync(abs, 'utf8');
};

const write = (p, next, prev) => {
  if (next === prev) {
    console.log(`• 无变化，跳过：${p}`);
    skipped += 1;
    return;
  }
  if (CHECK) {
    console.log(`• [check] 将更新：${p}`);
  } else {
    writeFileSync(rel(p), next, 'utf8');
    console.log(`✓ 已更新：${p}`);
  }
  changed += 1;
};

/** 精确单处替换：断言 find 恰好出现 1 次，杜绝歧义/漂移。 */
const replaceOnce = (content, find, replace, label) => {
  const n = content.split(find).length - 1;
  if (n === 0) throw new Error(`匹配失败（0 处）：${label}`);
  if (n > 1) throw new Error(`匹配歧义（${n} 处）：${label}`);
  return content.replace(find, () => replace);
};

// ---------------------------------------------------------------------------
// 1) entriesMirrorBridge.ts
// ---------------------------------------------------------------------------
const BRIDGE = 'src/store/aiThread/entriesMirrorBridge.ts';
{
  const prev = read(BRIDGE);
  if (!prev.includes('resolveMirrorOnHydrate')) {
    console.log(`• 已无 resolveMirrorOnHydrate，跳过：${BRIDGE}`);
    skipped += 1;
  } else {
    let next = prev;

    // 1a) 收窄 import：移除仅供死函数使用的 hydrate import 与 hydrateAiThreadEntriesSnapshot
    next = replaceOnce(
      next,
      `import type { IAiConversationThread } from '@/store/aiConversation';\n` +
        `import { type IResolvedPersistedThreads, resolvePersistedThreads } from '@/store/aiThread/hydrate';\n` +
        `import { projectConversationToThreadPersist } from '@/store/aiThread/project';\n` +
        `import {\n` +
        `  hydrateAiThreadEntriesSnapshot,\n` +
        `  scheduleAiThreadEntriesPersist,\n` +
        `} from '@/store/plugins/aiThreadEntriesStorage';`,
      `import type { IAiConversationThread } from '@/store/aiConversation';\n` +
        `import { projectConversationToThreadPersist } from '@/store/aiThread/project';\n` +
        `import { scheduleAiThreadEntriesPersist } from '@/store/plugins/aiThreadEntriesStorage';`,
      'bridge: imports',
    );

    // 1b) 收窄 deps 接口 + defaultDeps（去 hydrateSnapshot），删 parseRawEntriesSnapshot
    next = replaceOnce(
      next,
      `export interface IEntriesMirrorDeps {\n` +
        `  schedulePersist: (value: string) => void;\n` +
        `  hydrateSnapshot: () => Promise<{ raw: string | null }>;\n` +
        `}\n\n` +
        `const defaultDeps: IEntriesMirrorDeps = {\n` +
        `  schedulePersist: scheduleAiThreadEntriesPersist,\n` +
        `  hydrateSnapshot: hydrateAiThreadEntriesSnapshot,\n` +
        `};\n\n` +
        `const parseRawEntriesSnapshot = (raw: string | null): unknown => {\n` +
        `  if (raw === null) return null;\n` +
        `  try {\n` +
        `    return JSON.parse(raw) as unknown;\n` +
        `  } catch {\n` +
        `    return null;\n` +
        `  }\n` +
        `};\n`,
      `export interface IEntriesMirrorDeps {\n` +
        `  schedulePersist: (value: string) => void;\n` +
        `}\n\n` +
        `const defaultDeps: IEntriesMirrorDeps = {\n` +
        `  schedulePersist: scheduleAiThreadEntriesPersist,\n` +
        `};\n`,
      'bridge: deps + parseRawEntriesSnapshot',
    );

    // 1c) 删除 resolveMirrorOnHydrate 函数本体（含其前置 doc 与尾随空行）
    next = replaceOnce(
      next,
      `/**\n` +
        ` * 读取新 key 快照并经 7.3 resolver 解析 (读路径自检)。\n` +
        ` * 新 key 有效 → source 'entries'; 否则回退到 legacy 投影。结果供 7.4d/7.5 接入,\n` +
        ` * 当前不改变渲染 SoT。\n` +
        ` */\n` +
        `export const resolveMirrorOnHydrate = async (\n` +
        `  store: IConversationStoreLike,\n` +
        `  deps: IEntriesMirrorDeps = defaultDeps,\n` +
        `): Promise<IResolvedPersistedThreads> => {\n` +
        `  const { raw } = await deps.hydrateSnapshot();\n` +
        `  return resolvePersistedThreads({\n` +
        `    rawEntriesSnapshot: parseRawEntriesSnapshot(raw),\n` +
        `    legacyActiveThreadId: store.activeThreadId,\n` +
        `    legacyThreads: store.threads,\n` +
        `  });\n` +
        `};\n\n`,
      ``,
      'bridge: resolveMirrorOnHydrate fn',
    );

    write(BRIDGE, next, prev);
  }
}

// ---------------------------------------------------------------------------
// 2) entriesMirrorBridge.spec.ts
// ---------------------------------------------------------------------------
const SPEC = 'src/store/aiThread/entriesMirrorBridge.spec.ts';
{
  const prev = read(SPEC);
  if (!prev.includes('resolveMirrorOnHydrate')) {
    console.log(`• 已无 resolveMirrorOnHydrate，跳过：${SPEC}`);
    skipped += 1;
  } else {
    let next = prev;

    // 2a) import：移除 resolveMirrorOnHydrate 与（随用例失活的）projectConversationToThreadPersist
    next = replaceOnce(
      next,
      `import {\n` +
        `  type IConversationStoreLike,\n` +
        `  type IEntriesMirrorDeps,\n` +
        `  installEntriesMirror,\n` +
        `  mirrorConversationToEntries,\n` +
        `  resolveMirrorOnHydrate,\n` +
        `} from '@/store/aiThread/entriesMirrorBridge';\n` +
        `import { projectConversationToThreadPersist } from '@/store/aiThread/project';`,
      `import {\n` +
        `  type IConversationStoreLike,\n` +
        `  type IEntriesMirrorDeps,\n` +
        `  installEntriesMirror,\n` +
        `  mirrorConversationToEntries,\n` +
        `} from '@/store/aiThread/entriesMirrorBridge';`,
      'spec: imports',
    );

    // 2b) makeDeps：移除 raw / setRaw / hydrateSnapshot（仅死用例用到）
    next = replaceOnce(
      next,
      `const makeDeps = () => {\n` +
        `  const scheduled: string[] = [];\n` +
        `  let raw: string | null = null;\n` +
        `  const deps: IEntriesMirrorDeps = {\n` +
        `    schedulePersist: (value: string) => {\n` +
        `      scheduled.push(value);\n` +
        `    },\n` +
        `    hydrateSnapshot: async () => ({ raw }),\n` +
        `  };\n` +
        `  return {\n` +
        `    deps,\n` +
        `    scheduled,\n` +
        `    setRaw: (value: string | null) => {\n` +
        `      raw = value;\n` +
        `    },\n` +
        `  };\n` +
        `};`,
      `const makeDeps = () => {\n` +
        `  const scheduled: string[] = [];\n` +
        `  const deps: IEntriesMirrorDeps = {\n` +
        `    schedulePersist: (value: string) => {\n` +
        `      scheduled.push(value);\n` +
        `    },\n` +
        `  };\n` +
        `  return {\n` +
        `    deps,\n` +
        `    scheduled,\n` +
        `  };\n` +
        `};`,
      'spec: makeDeps',
    );

    // 2c) 删除两个 resolveMirrorOnHydrate 用例
    next = replaceOnce(
      next,
      `\n\n  it('resolveMirrorOnHydrate: 新 key 有效 → source entries', async () => {\n` +
        `    const { deps, setRaw } = makeDeps();\n` +
        `    const store = makeStore([makeLegacyThread('a'), makeLegacyThread('b')], 'a');\n` +
        `    const projected = projectConversationToThreadPersist({\n` +
        `      activeThreadId: 'a',\n` +
        `      threads: [makeLegacyThread('a'), makeLegacyThread('b')],\n` +
        `    });\n` +
        `    setRaw(JSON.stringify(projected));\n` +
        `    const resolved = await resolveMirrorOnHydrate(store, deps);\n` +
        `    expect(resolved.source).toBe('entries');\n` +
        `    expect(resolved.threads.map((t) => t.id)).toEqual(['a', 'b']);\n` +
        `  });\n\n` +
        `  it('resolveMirrorOnHydrate: 新 key 为空 → 回退 legacy', async () => {\n` +
        `    const { deps, setRaw } = makeDeps();\n` +
        `    setRaw(null);\n` +
        `    const store = makeStore([makeLegacyThread('x')], 'x');\n` +
        `    const resolved = await resolveMirrorOnHydrate(store, deps);\n` +
        `    expect(resolved.source).toBe('legacy');\n` +
        `    expect(resolved.threads.map((t) => t.id)).toEqual(['x']);\n` +
        `  });`,
      ``,
      'spec: resolveMirrorOnHydrate tests',
    );

    write(SPEC, next, prev);
  }
}

console.log(`\n完成：变更 ${changed} 个文件，跳过 ${skipped} 个。${CHECK ? '（dry-run）' : ''}`);