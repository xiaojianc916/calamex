// 1.mjs — Step 8 砖3① 渲染权威纯核心（未接线，零行为）
// 运行：node 1.mjs  （仓库根目录 D:\com.xiaojianc\my_desktop_app）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const p = (rel) => resolve(root, rel);

function replaceOnce(content, oldStr, newStr, label) {
  const parts = content.split(oldStr);
  if (parts.length !== 2) {
    throw new Error(`[${label}] 期望命中 1 处锚点，实际命中 ${parts.length - 1} 处`);
  }
  return parts[0] + newStr + parts[1];
}

/* ---------- 1) 新建纯函数模块 render-authority.ts ---------- */
const renderAuthorityTs = [
  '/* ============================================================================',
  ' * 渲染权威选择（ADR-0013 / ADR-0014 Step 8 砖3①）',
  ' *',
  ' * 纯函数、无副作用：在 entries 权威线程（authoritative）与既有 legacy 投影',
  ' * （liveThread ?? 投影 ?? 持久化）之间选择渲染真源。',
  ' *',
  ' * 切换语义（strangler）：authoritative 持有 entries 时以其为准，否则回退 legacy。',
  ' * 写路径接管（砖3②起）前 authoritative 恒为空线程 → 始终回退 legacy → 逐线程',
  ' * 零行为变化；写路径接管后 authoritative 自然胜出，无需二次改读侧。',
  ' * ========================================================================== */',
  "import type { IAiThread } from '@/types/ai/thread';",
  '',
  '/**',
  ' * 渲染线程真源选择：authoritative 含 entries 时优先，否则回退 fallback。',
  ' * @param authoritative entries 权威活动线程（砖2b store）',
  ' * @param fallback 既有渲染链路（liveThread ?? 投影 ?? 持久化）',
  ' */',
  'export function selectRenderThread(',
  '  authoritative: IAiThread | null,',
  '  fallback: IAiThread | null,',
  '): IAiThread | null {',
  '  return authoritative && authoritative.entries.length > 0 ? authoritative : fallback;',
  '}',
  '',
].join('\n');
writeFileSync(p('src/store/aiThread/render-authority.ts'), renderAuthorityTs, 'utf8');

/* ---------- 2) 新建纯函数单测 render-authority.spec.ts ---------- */
const renderAuthoritySpec = [
  "import { describe, expect, it } from 'vitest';",
  '',
  "import { selectRenderThread } from '@/store/aiThread/render-authority';",
  "import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';",
  '',
  'const entry = {} as unknown as IAiThreadEntry;',
  '',
  'function makeThread(id: string, entries: IAiThreadEntry[]): IAiThread {',
  '  return { id, entries } as unknown as IAiThread;',
  '}',
  '',
  "describe('selectRenderThread', () => {",
  "  it('authoritative 持有 entries 时以其为渲染真源', () => {",
  "    const authoritative = makeThread('a', [entry]);",
  "    const fallback = makeThread('legacy', [entry, entry]);",
  '    expect(selectRenderThread(authoritative, fallback)).toBe(authoritative);',
  '  });',
  '',
  "  it('authoritative 为空 entries 时回退 legacy', () => {",
  "    const authoritative = makeThread('a', []);",
  "    const fallback = makeThread('legacy', [entry]);",
  '    expect(selectRenderThread(authoritative, fallback)).toBe(fallback);',
  '  });',
  '',
  "  it('authoritative 为 null 时回退 legacy', () => {",
  "    const fallback = makeThread('legacy', [entry]);",
  '    expect(selectRenderThread(null, fallback)).toBe(fallback);',
  '  });',
  '',
  "  it('authoritative 空 entries 且 fallback 为 null 时返回 null', () => {",
  "    expect(selectRenderThread(makeThread('a', []), null)).toBeNull();",
  '  });',
  '',
  "  it('authoritative 与 fallback 皆 null 时返回 null', () => {",
  '    expect(selectRenderThread(null, null)).toBeNull();',
  '  });',
  '});',
  '',
].join('\n');
writeFileSync(p('src/store/aiThread/render-authority.spec.ts'), renderAuthoritySpec, 'utf8');

/* ---------- 3) 接入 index.ts（仅导出 getter，未接线） ---------- */
const idxPath = p('src/store/aiThread/index.ts');
let idx = readFileSync(idxPath, 'utf8');

// 3a) import（置于 legacy-adapter 与 thread-mutations 之间，符合字母序）
idx = replaceOnce(
  idx,
  "import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';\nimport * as threadMutations from '@/store/aiThread/thread-mutations';",
  "import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';\nimport { selectRenderThread } from '@/store/aiThread/render-authority';\nimport * as threadMutations from '@/store/aiThread/thread-mutations';",
  'import',
);

// 3b) 在 authoritativeHasEntries 之后、readAuthoritativeState 之前插入渲染权威 getter
idx = replaceOnce(
  idx,
  "  const authoritativeHasEntries = computed<boolean>(\n    () => authoritativeActiveEntries.value.length > 0,\n  );\n\n  const readAuthoritativeState = (): threadMutations.IAiThreadState => ({",
  [
    '  const authoritativeHasEntries = computed<boolean>(',
    '    () => authoritativeActiveEntries.value.length > 0,',
    '  );',
    '',
    '  /* ----- Step 8 砖3①：渲染权威（authoritative 优先，legacy 投影回退，未接线）-----',
    '   * 渲染层当前仍读 activeThread / activeEntries；砖3② 才把 Panel 渲染来源切到此。',
    '   * authoritative 持有 entries 时以其为渲染真源，否则回退既有 liveThread ?? 投影',
    '   * ?? 持久化 链路，保证写路径接管前逐线程零行为变化。',
    '   */',
    '  const renderActiveThread = computed<IAiThread | null>(() =>',
    '    selectRenderThread(authoritativeActiveThread.value, activeThread.value),',
    '  );',
    '  const renderActiveEntries = computed<IAiThreadEntry[]>(',
    '    () => renderActiveThread.value?.entries ?? [],',
    '  );',
    '',
    '  const readAuthoritativeState = (): threadMutations.IAiThreadState => ({',
  ].join('\n'),
  'getters',
);

// 3c) 在 return 的权威读派生之后导出渲染权威 getter
idx = replaceOnce(
  idx,
  '    // Step 8 砖2b：entries 权威读派生（未接线）\n    authoritativeActiveThread,\n    authoritativeActiveEntries,\n    authoritativeHistoryThreads,\n    authoritativeHasEntries,\n    // actions',
  '    // Step 8 砖2b：entries 权威读派生（未接线）\n    authoritativeActiveThread,\n    authoritativeActiveEntries,\n    authoritativeHistoryThreads,\n    authoritativeHasEntries,\n    // Step 8 砖3①：渲染权威 getter（未接线）\n    renderActiveThread,\n    renderActiveEntries,\n    // actions',
  'return-exports',
);

// 3d) barrel 再导出（reduce 之后，符合字母序）
idx = replaceOnce(
  idx,
  "export * from '@/store/aiThread/events';\nexport * from '@/store/aiThread/legacy-adapter';\nexport * from '@/store/aiThread/reduce';",
  "export * from '@/store/aiThread/events';\nexport * from '@/store/aiThread/legacy-adapter';\nexport * from '@/store/aiThread/reduce';\nexport * from '@/store/aiThread/render-authority';",
  'barrel',
);

writeFileSync(idxPath, idx, 'utf8');

console.log('✓ Step 8 砖3① 完成：render-authority.ts(+spec) 新建，index.ts 接入渲染权威 getter（未接线）');