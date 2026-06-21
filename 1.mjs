// step5a-render-authority.mjs
// Step 5a（双轨拆除·渲染权威）：selectRenderThread 恒以 authoritative 为渲染真源，
// 退役 legacy 投影回退分支（生产中已恒为空、不再被消费）。
// 用法：
//   node step5a-render-authority.mjs           # 预演（dry-run，不写盘）
//   node step5a-render-authority.mjs --apply   # 实际写盘（保留各文件原始 EOL）
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const edits = [
  {
    file: 'src/store/aiThread/render-authority.ts',
    replacements: [
      {
        find: ` * 切换语义（strangler）：authoritative 持有 entries 时以其为准，否则回退 legacy。
 * 写路径接管（砖3②起）前 authoritative 恒为空线程 → 始终回退 legacy → 逐线程
 * 零行为变化；写路径接管后 authoritative 自然胜出，无需二次改读侧。`,
        to: ` * 双轨拆除（Step 5）：写路径已全面接管 authoritative，故渲染权威恒等于
 * authoritative；legacy 投影回退链路在生产中恒为空、不再被消费，回退分支退役。`,
      },
      {
        find: `/**
 * 渲染线程真源选择：authoritative 含 entries 时优先，否则回退 fallback。
 * @param authoritative entries 权威活动线程（砖2b store）
 * @param fallback 既有渲染链路（liveThread ?? 投影 ?? 持久化）
 */
export function selectRenderThread(
  authoritative: IAiThread | null,
  fallback: IAiThread | null,
): IAiThread | null {
  return authoritative && authoritative.entries.length > 0 ? authoritative : fallback;
}`,
        to: `/**
 * 渲染线程真源选择：恒以 entries 权威活动线程为准（含空 entries 的空线程）。
 * @param authoritative entries 权威活动线程（砖2b store）
 */
export function selectRenderThread(authoritative: IAiThread | null): IAiThread | null {
  return authoritative;
}`,
      },
    ],
  },
  {
    file: 'src/store/aiThread/render-authority.spec.ts',
    replacements: [
      {
        find: `describe('selectRenderThread', () => {
  it('authoritative 持有 entries 时以其为渲染真源', () => {
    const authoritative = makeThread('a', [entry]);
    const fallback = makeThread('legacy', [entry, entry]);
    expect(selectRenderThread(authoritative, fallback)).toBe(authoritative);
  });

  it('authoritative 为空 entries 时回退 legacy', () => {
    const authoritative = makeThread('a', []);
    const fallback = makeThread('legacy', [entry]);
    expect(selectRenderThread(authoritative, fallback)).toBe(fallback);
  });

  it('authoritative 为 null 时回退 legacy', () => {
    const fallback = makeThread('legacy', [entry]);
    expect(selectRenderThread(null, fallback)).toBe(fallback);
  });

  it('authoritative 空 entries 且 fallback 为 null 时返回 null', () => {
    expect(selectRenderThread(makeThread('a', []), null)).toBeNull();
  });

  it('authoritative 与 fallback 皆 null 时返回 null', () => {
    expect(selectRenderThread(null, null)).toBeNull();
  });
});`,
        to: `describe('selectRenderThread', () => {
  it('始终以 authoritative 为渲染真源（含空 entries）', () => {
    const authoritative = makeThread('a', []);
    expect(selectRenderThread(authoritative)).toBe(authoritative);
  });

  it('authoritative 持有 entries 时返回该线程', () => {
    const authoritative = makeThread('a', [entry]);
    expect(selectRenderThread(authoritative)).toBe(authoritative);
  });

  it('authoritative 为 null 时返回 null', () => {
    expect(selectRenderThread(null)).toBeNull();
  });
});`,
      },
    ],
  },
  {
    file: 'src/store/aiThread/index.ts',
    replacements: [
      {
        find: `  /* ----- Step 8 砟3①：渲染权威（authoritative 优先，legacy 投影回退，未接线）-----
   * 渲染层当前仍读 activeThread / activeEntries；砟3② 才把 Panel 渲染来源切到此。
   * authoritative 持有 entries 时以其为渲染真源，否则回退既有 liveThread ?? 投影
   * ?? 持久化 链路，保证写路径接管前逐线程零行为变化。
   */
  const renderActiveThread = computed<IAiThread | null>(() =>
    selectRenderThread(authoritativeActiveThread.value, activeThread.value),
  );`,
        to: `  /* ----- Step 8 砟3① / Step 5 双轨拆除：渲染权威 = authoritative -----
   * Panel 已切到 renderActiveThread / renderActiveEntries 作为唯一渲染来源；写路径
   * 全面接管后 authoritative 即渲染真源，legacy 投影回退链路（activeThread）退役。
   */
  const renderActiveThread = computed<IAiThread | null>(() =>
    selectRenderThread(authoritativeActiveThread.value),
  );`,
      },
    ],
  },
];

const results = [];
const outputs = [];
let hadError = false;

for (const { file, replacements } of edits) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    hadError = true;
    results.push(`✗ ${file}: 读取失败 (${e.message})`);
    continue;
  }
  const crlf = raw.includes('\r\n');
  let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  let fileOk = true;
  for (let i = 0; i < replacements.length; i += 1) {
    const { find, to } = replacements[i];
    const count = text.split(find).length - 1;
    if (count !== 1) {
      hadError = true;
      fileOk = false;
      results.push(`✗ ${file} [替换#${i + 1}]: 期望命中 1 次，实际 ${count} 次`);
      continue;
    }
    text = text.replace(find, () => to);
  }
  if (!fileOk) continue;
  outputs.push({ file, out: crlf ? text.replace(/\n/g, '\r\n') : text, n: replacements.length });
  results.push(`• ${file}: 校验通过 (${replacements.length} 处)`);
}

console.log(results.join('\n'));

if (hadError) {
  console.error('\n存在未命中，已全部中止（未写盘）。请核对源文件是否已被改动。');
  process.exit(1);
}
if (!APPLY) {
  console.log('\n预演通过（dry-run）。加 --apply 实际写盘。');
  process.exit(0);
}
for (const { file, out, n } of outputs) {
  writeFileSync(file, out, 'utf8');
  console.log(`✓ 已写入 ${file} (${n} 处)`);
}
console.log('\n完成。请运行 pnpm vitest run 与 pnpm -s vue-tsc --noEmit 验证。');