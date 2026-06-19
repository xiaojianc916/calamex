#!/usr/bin/env node
// scripts/codemod/step7-4a-project-conversation.mjs
//
// Step 7.4a —— 写侧投影砖 (CREATE-only, 零运行时变化)
//
// 新建:
//   src/store/aiThread/project.ts        legacy 会话 → aiThreadPersist 投影 (纯函数)
//   src/store/aiThread/project.spec.ts   单测 (含 project→parse→resolve 往返对称)
//
// 该步是 7.3 读 resolver 的对称写砖, 为后续 7.4b 的"双写新 key"提供序列化入口。
// 不修改任何既有文件; 不接线 main.ts / store; 不引入 idb。
//
// 依赖前置 (缺失即提前失败, 零写入):
//   - 7.3 已应用: src/store/aiThread/hydrate.ts 含 normalizeActiveThreadId / resolvePersistedThreads
//   - 7.1 已在 main: src/types/ai/thread/persist.schema.ts 含 AI_THREAD_PERSIST_VERSION / aiThreadPersistSchema
//   - main 既有:    src/store/aiThread/legacy-adapter.ts 含 legacyThreadToThread
//
// 用法:
//   node scripts/codemod/step7-4a-project-conversation.mjs --check   # 干跑, 只校验/预览
//   node scripts/codemod/step7-4a-project-conversation.mjs           # 写入 (目标已存在则拒绝)
//   node scripts/codemod/step7-4a-project-conversation.mjs --force   # 覆盖已存在目标
//   REPO_ROOT=/path/to/repo node scripts/codemod/step7-4a-project-conversation.mjs

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const argv = new Set(process.argv.slice(2));
const CHECK = argv.has('--check');
const FORCE = argv.has('--force');

const log = (...a) => console.log('[step7-4a]', ...a);
const fail = (msg) => {
  console.error('[step7-4a] ✗', msg);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 依赖前置校验 token (路径相对 REPO_ROOT → 必须包含的导出名)
// ---------------------------------------------------------------------------
const PRECONDITIONS = [
  {
    path: 'src/store/aiThread/hydrate.ts',
    tokens: ['normalizeActiveThreadId', 'resolvePersistedThreads'],
    hint: '请先应用 step7-3-hydrate-resolver.mjs (7.3 尚未落地)。',
  },
  {
    path: 'src/store/aiThread/legacy-adapter.ts',
    tokens: ['legacyThreadToThread'],
    hint: 'legacy-adapter 缺少 legacyThreadToThread, 与预期 main 不符。',
  },
  {
    path: 'src/types/ai/thread/persist.schema.ts',
    tokens: ['AI_THREAD_PERSIST_VERSION', 'aiThreadPersistSchema'],
    hint: '请先合入 7.1 (entries persist schema)。',
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

// ---------------------------------------------------------------------------
// 待创建文件
// ---------------------------------------------------------------------------
const PROJECT_TS = [
  "import type { IAiConversationThread } from '@/store/aiConversation';",
  "import { normalizeActiveThreadId } from '@/store/aiThread/hydrate';",
  "import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';",
  "import type { IAiThread } from '@/types/ai/thread';",
  "import { AI_THREAD_PERSIST_VERSION, type IAiThreadPersist } from '@/types/ai/thread/persist.schema';",
  '',
  '// ---------------------------------------------------------------------------',
  '// 写侧投影 (7.3 读 resolver 的对称砖)',
  '//',
  '// 把 legacy 会话状态 (activeThreadId + IAiConversationThread[]) 投影成新 entries',
  '// 持久化形状 IAiThreadPersist。供后续 7.4b 双写新 key 时序列化使用。',
  '//',
  '// 设计取舍 (质量优先):',
  '// - 忠实 1:1 镜像: 不在此处做 history-limit / 空线程过滤, 避免与读路径 (resolver)',
  '//   产生不对称, 保证 project → parse → resolvePersistedThreads 往返一致。',
  '// - 复用既有单一来源: 线程映射走 legacyThreadToThread, active 归一走 7.3 的',
  '//   normalizeActiveThreadId, 不重复实现。',
  '// - 纯函数: 无 idb / 无 async / 无 store 依赖, 完全可单测。',
  '// ---------------------------------------------------------------------------',
  '',
  'export interface IProjectConversationInput {',
  '  activeThreadId: string | null;',
  '  threads: IAiConversationThread[];',
  '}',
  '',
  '/** 逐线程把 legacy 会话线程投影为 entries 线程, 保持顺序。 */',
  'export const projectConversationThreadsToEntries = (',
  '  threads: IAiConversationThread[],',
  '): IAiThread[] => threads.map(legacyThreadToThread);',
  '',
  '/**',
  ' * 把 legacy 会话状态投影成 IAiThreadPersist。',
  ' * 产出对 aiThreadPersistSchema 恒为合法 (version 取当前版本, activeThreadId 归一)。',
  ' */',
  'export const projectConversationToThreadPersist = (',
  '  input: IProjectConversationInput,',
  '): IAiThreadPersist => {',
  '  const threads = projectConversationThreadsToEntries(input.threads);',
  '  return {',
  '    version: AI_THREAD_PERSIST_VERSION,',
  '    activeThreadId: normalizeActiveThreadId(input.activeThreadId, threads),',
  '    threads,',
  '  };',
  '};',
  '',
].join('\n');

const PROJECT_SPEC_TS = [
  "import { describe, expect, it } from 'vitest';",
  "import type { IAiConversationThread } from '@/store/aiConversation';",
  "import { resolvePersistedThreads } from '@/store/aiThread/hydrate';",
  "import {",
  '  projectConversationThreadsToEntries,',
  '  projectConversationToThreadPersist,',
  "} from '@/store/aiThread/project';",
  "import { AI_THREAD_PERSIST_VERSION, aiThreadPersistSchema } from '@/types/ai/thread/persist.schema';",
  '',
  'const makeLegacyThread = (',
  '  id: string,',
  '  overrides: Record<string, unknown> = {},',
  '): IAiConversationThread =>',
  '  ({',
  "    id,",
  "    title: 'T-' + id,",
  "    titleStatus: 'temporary',",
  "    createdAt: '2026-01-01T00:00:00.000Z',",
  "    updatedAt: '2026-01-01T00:00:00.000Z',",
  '    messages: [],',
  '    ...overrides,',
  '  }) as unknown as IAiConversationThread;',
  '',
  "describe('projectConversationToThreadPersist', () => {",
  "  it('空线程 → version + null active + 空数组', () => {",
  '    const result = projectConversationToThreadPersist({ activeThreadId: null, threads: [] });',
  '    expect(result.version).toBe(AI_THREAD_PERSIST_VERSION);',
  '    expect(result.activeThreadId).toBeNull();',
  '    expect(result.threads).toEqual([]);',
  '    expect(aiThreadPersistSchema.safeParse(result).success).toBe(true);',
  '  });',
  '',
  "  it('单线程 → active 落在该线程, 且 schema 合法', () => {",
  "    const result = projectConversationToThreadPersist({",
  "      activeThreadId: 'a',",
  "      threads: [makeLegacyThread('a')],",
  '    });',
  '    expect(result.threads).toHaveLength(1);',
  "    expect(result.activeThreadId).toBe('a');",
  '    expect(aiThreadPersistSchema.safeParse(result).success).toBe(true);',
  '  });',
  '',
  "  it('active 指向不存在的线程 → 归一到首个线程', () => {",
  "    const result = projectConversationToThreadPersist({",
  "      activeThreadId: 'missing',",
  "      threads: [makeLegacyThread('a'), makeLegacyThread('b')],",
  '    });',
  "    expect(result.activeThreadId).toBe('a');",
  '  });',
  '',
  "  it('active 为 null 但有线程 → 归一到首个线程', () => {",
  "    const result = projectConversationToThreadPersist({",
  "      activeThreadId: null,",
  "      threads: [makeLegacyThread('x'), makeLegacyThread('y')],",
  '    });',
  "    expect(result.activeThreadId).toBe('x');",
  '  });',
  '',
  "  it('保持线程顺序', () => {",
  "    const result = projectConversationToThreadPersist({",
  "      activeThreadId: 'b',",
  "      threads: [makeLegacyThread('a'), makeLegacyThread('b'), makeLegacyThread('c')],",
  '    });',
  "    expect(result.threads.map((t) => t.id)).toEqual(['a', 'b', 'c']);",
  '  });',
  '',
  "  it('往返对称: project → parse → resolvePersistedThreads 得 entries', () => {",
  "    const projected = projectConversationToThreadPersist({",
  "      activeThreadId: 'a',",
  "      threads: [makeLegacyThread('a'), makeLegacyThread('b')],",
  '    });',
  '    const parsed = aiThreadPersistSchema.safeParse(projected);',
  '    expect(parsed.success).toBe(true);',
  '    if (!parsed.success) return;',
  '    const resolved = resolvePersistedThreads({',
  '      rawEntriesSnapshot: parsed.data,',
  '      legacyActiveThreadId: null,',
  '      legacyThreads: [],',
  '    });',
  "    expect(resolved.source).toBe('entries');",
  "    expect(resolved.threads.map((t) => t.id)).toEqual(['a', 'b']);",
  "    expect(resolved.activeThreadId).toBe('a');",
  '  });',
  '});',
  '',
  "describe('projectConversationThreadsToEntries', () => {",
  "  it('逐线程映射且保持顺序', () => {",
  "    const out = projectConversationThreadsToEntries([",
  "      makeLegacyThread('a'),",
  "      makeLegacyThread('b'),",
  '    ]);',
  "    expect(out.map((t) => t.id)).toEqual(['a', 'b']);",
  '  });',
  '});',
  '',
].join('\n');

const FILES = [
  { path: 'src/store/aiThread/project.ts', content: PROJECT_TS },
  { path: 'src/store/aiThread/project.spec.ts', content: PROJECT_SPEC_TS },
];

// ---------------------------------------------------------------------------
// 执行 (事务式: 任一前置/冲突失败即零写入)
// ---------------------------------------------------------------------------
const run = () => {
  log('REPO_ROOT =', REPO_ROOT);
  log(CHECK ? '模式: --check (干跑)' : FORCE ? '模式: 写入 (--force 覆盖)' : '模式: 写入');

  const preErrors = checkPreconditions();
  if (preErrors.length > 0) {
    preErrors.forEach((e) => console.error('[step7-4a] ✗ 前置:', e));
    fail('依赖前置校验失败, 未写入任何文件。');
  }
  log('✓ 依赖前置校验通过 (7.3 / 7.1 / legacy-adapter)');

  const conflicts = FILES.filter((f) => existsSync(join(REPO_ROOT, f.path)));
  if (conflicts.length > 0 && !FORCE) {
    conflicts.forEach((f) => console.error('[step7-4a] ✗ 目标已存在:', f.path));
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