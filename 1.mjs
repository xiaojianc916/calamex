// 2.mjs — ADR-0014 ④.1 §A+§B+§C-bis：权威 entries 持久化镜像基座（纯加性、零行为变化）
// 运行：仓库根 node 2.mjs ；随后 pnpm typecheck && pnpm lint && pnpm test
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mk = (lines) => lines.join('\n');

function replaceOnce(content, find, replace, tag) {
  const first = content.indexOf(find);
  if (first === -1) throw new Error(`[${tag}] 锚点未命中`);
  if (content.indexOf(find, first + find.length) !== -1)
    throw new Error(`[${tag}] 锚点出现多次，需更大唯一锚点`);
  return content.slice(0, first) + replace + content.slice(first + find.length);
}

function editFile(relPath, edits) {
  const abs = resolve(process.cwd(), relPath);
  let content = readFileSync(abs, 'utf8');
  for (const e of edits) content = replaceOnce(content, e.find, e.replace, `${relPath} :: ${e.tag}`);
  writeFileSync(abs, content, 'utf8');
  console.log(`✓ ${relPath} (${edits.length} edit${edits.length > 1 ? 's' : ''})`);
}

function writeFreshFile(relPath, lines) {
  const abs = resolve(process.cwd(), relPath);
  if (existsSync(abs)) throw new Error(`[${relPath}] 已存在，拒绝覆盖`);
  writeFileSync(abs, mk(lines) + '\n', 'utf8');
  console.log(`✓ 新建 ${relPath} (${lines.length} 行)`);
}

/* ========================================================================== */
/* §A 新模块：src/store/aiThread/authoritativeEntriesMirror.ts                 */
/* ========================================================================== */
writeFreshFile('src/store/aiThread/authoritativeEntriesMirror.ts', [
  "/* ============================================================================",
  " * 权威 entries → 持久化镜像（ADR-0014 Step 8 ④.1 / §A）",
  " *",
  " * entriesMirrorBridge 的「权威版」：当持久化 SoT 从 legacy aiConversation 切换到",
  " * aiThread store 的权威 entries 状态后，由本模块把权威线程投影为 IAiThreadPersist",
  " * 并写入 entries 新 key。与 entriesMirrorBridge 对称：副作用经 deps 注入，默认绑定",
  " * 真实镜像引擎，便于单测且与实现解耦。",
  " *",
  " * 与 project.ts 的关系：authoritative 状态已是 entries 模型（IAiThread[]），无需",
  " * legacy→entries 投影，仅做信封封装 + activeThreadId 归一（复用 normalizeActiveThreadId，",
  " * 与读路径 resolver 对称，保证 project→parse→resolve 往返一致）。",
  " *",
  " * 接线见 main.ts（§C）：在 runStartupPersistedRead 灌入权威线程之后安装，避免首帧",
  " * 空态镜像覆盖磁盘历史。",
  " * ========================================================================== */",
  "import { normalizeActiveThreadId } from '@/store/aiThread/hydrate';",
  "import { scheduleAiThreadEntriesPersist } from '@/store/plugins/aiThreadEntriesStorage';",
  "import type { IAiThread } from '@/types/ai/thread';",
  "import { AI_THREAD_PERSIST_VERSION, type IAiThreadPersist } from '@/types/ai/thread/persist.schema';",
  "",
  "/** 镜像所需的 aiThread store 最小形状（便于注入假 store 测试）。 */",
  "export interface IAuthoritativeStoreLike {",
  "  authoritativeThreads: IAiThread[];",
  "  authoritativeActiveThreadId: string | null;",
  "  $subscribe: (callback: () => void) => unknown;",
  "}",
  "",
  "/** 可注入副作用（默认绑定真实镜像引擎）。 */",
  "export interface IAuthoritativeEntriesMirrorDeps {",
  "  schedulePersist: (value: string) => void;",
  "}",
  "",
  "const defaultDeps: IAuthoritativeEntriesMirrorDeps = {",
  "  schedulePersist: scheduleAiThreadEntriesPersist,",
  "};",
  "",
  "/** 权威状态（已是 entries 模型）→ 持久化信封；version 取当前版本，activeThreadId 归一。 */",
  "export const projectAuthoritativeToThreadPersist = (input: {",
  "  activeThreadId: string | null;",
  "  threads: IAiThread[];",
  "}): IAiThreadPersist => ({",
  "  version: AI_THREAD_PERSIST_VERSION,",
  "  activeThreadId: normalizeActiveThreadId(input.activeThreadId, input.threads),",
  "  threads: input.threads,",
  "});",
  "",
  "/** 投影当前权威状态为 entries 快照并入双写队列。 */",
  "export const mirrorAuthoritativeToEntries = (",
  "  store: IAuthoritativeStoreLike,",
  "  deps: IAuthoritativeEntriesMirrorDeps = defaultDeps,",
  "): void => {",
  "  const snapshot = projectAuthoritativeToThreadPersist({",
  "    activeThreadId: store.authoritativeActiveThreadId,",
  "    threads: store.authoritativeThreads,",
  "  });",
  "  deps.schedulePersist(JSON.stringify(snapshot));",
  "};",
  "",
  "/**",
  " * 安装权威镜像：立即镜像一次当前状态，并订阅后续变更继续镜像。",
  " * 返回取消订阅句柄（供卸载/回退）。",
  " */",
  "export const installAuthoritativeEntriesMirror = (",
  "  store: IAuthoritativeStoreLike,",
  "  deps: IAuthoritativeEntriesMirrorDeps = defaultDeps,",
  "): (() => void) => {",
  "  mirrorAuthoritativeToEntries(store, deps);",
  "  const stop = store.$subscribe(() => {",
  "    mirrorAuthoritativeToEntries(store, deps);",
  "  });",
  "  return typeof stop === 'function' ? (stop as () => void) : () => {};",
  "};",
]);

/* ========================================================================== */
/* §A spec：src/store/aiThread/authoritativeEntriesMirror.spec.ts（自洽，无 pinia） */
/* ========================================================================== */
writeFreshFile('src/store/aiThread/authoritativeEntriesMirror.spec.ts', [
  "import { describe, expect, it, vi } from 'vitest';",
  "",
  "import type { IAiThread } from '@/types/ai/thread';",
  "",
  "import {",
  "  installAuthoritativeEntriesMirror,",
  "  mirrorAuthoritativeToEntries,",
  "  projectAuthoritativeToThreadPersist,",
  "} from './authoritativeEntriesMirror';",
  "",
  "const makeThread = (id: string): IAiThread => ({",
  "  id,",
  "  title: `线程 ${id}`,",
  "  titleStatus: 'temporary',",
  "  createdAt: '2026-01-01T00:00:00.000Z',",
  "  updatedAt: '2026-01-01T00:00:00.000Z',",
  "  entries: [],",
  "});",
  "",
  "interface IFakeStore {",
  "  authoritativeThreads: IAiThread[];",
  "  authoritativeActiveThreadId: string | null;",
  "  $subscribe: (callback: () => void) => () => void;",
  "}",
  "",
  "const createFakeStore = (",
  "  threads: IAiThread[],",
  "  activeThreadId: string | null,",
  "): { store: IFakeStore; emit: () => void; stop: ReturnType<typeof vi.fn> } => {",
  "  let subscriber: (() => void) | null = null;",
  "  const stop = vi.fn();",
  "  const store: IFakeStore = {",
  "    authoritativeThreads: threads,",
  "    authoritativeActiveThreadId: activeThreadId,",
  "    $subscribe: (callback) => {",
  "      subscriber = callback;",
  "      return stop;",
  "    },",
  "  };",
  "  return { store, emit: () => subscriber?.(), stop };",
  "};",
  "",
  "describe('projectAuthoritativeToThreadPersist', () => {",
  "  it('归一 activeThreadId 并标注当前版本（指向不存在的线程时落到首个）', () => {",
  "    const threads = [makeThread('a'), makeThread('b')];",
  "    const persist = projectAuthoritativeToThreadPersist({ activeThreadId: 'missing', threads });",
  "    expect(persist.version).toBe(1);",
  "    expect(persist.activeThreadId).toBe('a');",
  "    expect(persist.threads).toBe(threads);",
  "  });",
  "",
  "  it('空库归一为 activeThreadId=null', () => {",
  "    const persist = projectAuthoritativeToThreadPersist({ activeThreadId: 'x', threads: [] });",
  "    expect(persist.activeThreadId).toBeNull();",
  "    expect(persist.threads).toEqual([]);",
  "  });",
  "});",
  "",
  "describe('mirrorAuthoritativeToEntries', () => {",
  "  it('投影权威状态并把 JSON 快照交给 schedulePersist', () => {",
  "    const schedulePersist = vi.fn();",
  "    const { store } = createFakeStore([makeThread('a')], 'a');",
  "    mirrorAuthoritativeToEntries(store, { schedulePersist });",
  "    expect(schedulePersist).toHaveBeenCalledTimes(1);",
  "    const payload = JSON.parse(schedulePersist.mock.calls[0]![0] as string);",
  "    expect(payload.version).toBe(1);",
  "    expect(payload.activeThreadId).toBe('a');",
  "    expect(payload.threads).toHaveLength(1);",
  "    expect(payload.threads[0].id).toBe('a');",
  "  });",
  "});",
  "",
  "describe('installAuthoritativeEntriesMirror', () => {",
  "  it('立即镜像一次，并在每次 store 变更后继续镜像；返回取消订阅句柄', () => {",
  "    const schedulePersist = vi.fn();",
  "    const { store, emit, stop } = createFakeStore([makeThread('a')], 'a');",
  "    const dispose = installAuthoritativeEntriesMirror(store, { schedulePersist });",
  "    expect(schedulePersist).toHaveBeenCalledTimes(1);",
  "    emit();",
  "    expect(schedulePersist).toHaveBeenCalledTimes(2);",
  "    expect(dispose).toBeTypeOf('function');",
  "    dispose();",
  "    expect(stop).toHaveBeenCalledTimes(1);",
  "  });",
  "});",
]);

/* ========================================================================== */
/* §B aiThread/index.ts：新增 overlayStreamingActiveThread（按 id upsert 保历史）  */
/* ========================================================================== */
editFile('src/store/aiThread/index.ts', [
  {
    tag: 'add overlayStreamingActiveThread fn',
    find: mk([
      '    commitAuthoritativeState(',
      '      threadMutations.commitThreadsState({ threads: [thread], activeThreadId: thread.id }),',
      '    );',
      '  }',
      '',
      '  /**',
      '   * 灌入启动迁移得到的持久化线程快照（见 7.5c 接线）。',
    ]),
    replace: mk([
      '    commitAuthoritativeState(',
      '      threadMutations.commitThreadsState({ threads: [thread], activeThreadId: thread.id }),',
      '    );',
      '  }',
      '',
      '  /**',
      '   * Step 8 ④.1（Approach B）：流式回合中以本回合权威 entries 覆盖**单条**活动线程，',
      '   * 保留历史其余线程。setStreamingActiveThread 以 [thread] 整组替换会抹掉历史线程，',
      '   * 在「续聊已有历史」场景丢失其它线程；overlay 改为按 id upsert（命中替换、未命中前插），',
      '   * 并把活动线程指向本回合，供 §D 编排器每帧覆盖时使用。仍经 commitThreadsState 归一',
      '   * （trim + ensureActiveThread），与 setStreamingActiveThread 行为一致。',
      '   */',
      '  function overlayStreamingActiveThread(thread: IAiThread): void {',
      '    const state = readAuthoritativeState();',
      '    const exists = state.threads.some((item) => item.id === thread.id);',
      '    const threads = exists',
      '      ? state.threads.map((item) => (item.id === thread.id ? thread : item))',
      '      : [thread, ...state.threads];',
      '    commitAuthoritativeState(',
      '      threadMutations.commitThreadsState({ threads, activeThreadId: thread.id }),',
      '    );',
      '  }',
      '',
      '  /**',
      '   * 灌入启动迁移得到的持久化线程快照（见 7.5c 接线）。',
    ]),
  },
  {
    tag: 'export overlayStreamingActiveThread',
    find: mk([
      '    // actions',
      '    setLiveThread,',
      '    setStreamingActiveThread,',
      '    setPersistedThreads,',
    ]),
    replace: mk([
      '    // actions',
      '    setLiveThread,',
      '    setStreamingActiveThread,',
      '    overlayStreamingActiveThread,',
      '    setPersistedThreads,',
    ]),
  },
]);

/* ========================================================================== */
/* §C-bis startupPersistedReadWiring.ts：导出 defaultDeps（供 §C main.ts 注入）    */
/* ========================================================================== */
editFile('src/store/aiThread/startupPersistedReadWiring.ts', [
  {
    tag: 'export defaultDeps',
    find: 'const defaultDeps: IRunStartupPersistedReadDeps = {',
    replace: 'export const defaultDeps: IRunStartupPersistedReadDeps = {',
  },
]);

console.log('\n✅ §A+§B+§C-bis 完成：权威 entries 持久化镜像基座就位（纯加性、零行为变化、未接线）');