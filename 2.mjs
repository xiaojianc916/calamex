// polish-comments-batch3.mjs
// 用法：仓库根目录运行  node polish-comments-batch3.mjs
// 作用：把若干「编辑痕迹 / changelog 噪音」注释，改成大厂风格的“说明为什么”的注释。
// 安全：逐条断言 find 在文件中恰好命中 1 次；命中 0 或多次则跳过并告警，绝不盲写。
//      纯注释改动，零逻辑 / 零 UX，git 可完整回退。

import { readFileSync, writeFileSync } from 'node:fs';

const NL = '\n';
const L = (...lines) => lines.join(NL);

const edits = [
  // ── src/store/git.ts ───────────────────────────────────────────────
  {
    file: 'src/store/git.ts',
    find: '/** Git store 后台任务（commit 统计 / PR 预载）失败时的统一日志通道，替代散落的 console.warn。 */',
    replace: '/** Git store 后台任务（commit 统计 / PR 预载）失败时的统一日志通道。 */',
  },
  {
    file: 'src/store/git.ts',
    find: L(
      '// commit-stats 的内存缓存/持久化/gc 现由 @tanstack/vue-query 承担(见 src/lib/query-client.ts)。',
      '// 这里只保留后台批量队列(产品逻辑)与 vue-query 的接线参数。',
    ),
    replace: L(
      '// commit-stats 的内存缓存/持久化/gc 由 @tanstack/vue-query 承担(见 src/lib/query-client.ts);',
      '// 此处仅维护后台批量队列(产品逻辑)与 vue-query 的接线参数。',
    ),
  },
  {
    file: 'src/store/git.ts',
    find: L(
      '// 提交详情/文件 diff/diff 预览均按 commit-id(及路径)寻址,内容不可变:',
      '// 交由 vue-query 缓存 + fetchQuery 去重,替代手写 Record 缓存与 pending 请求表。',
    ),
    replace: L(
      '// 提交详情/文件 diff/diff 预览均按 commit-id(及路径)寻址,内容不可变:',
      '// 交由 vue-query 缓存 + fetchQuery 去重同一 key 的并发请求。',
    ),
  },
  {
    file: 'src/store/git.ts',
    find: L(
      '  // baseline 缓存已迁入 vue-query：fetchQuery 去重 + staleTime=Infinity，',
      '  // 失效用 removeQueries。baselineEpoch 保留供调用方判断 baseline 是否已刷新。',
    ),
    replace: L(
      '  // baseline 缓存由 vue-query 承载：fetchQuery 去重 + staleTime=Infinity，',
      '  // 失效用 removeQueries。baselineEpoch 供调用方判断 baseline 是否已刷新。',
    ),
  },
  {
    file: 'src/store/git.ts',
    find: L(
      '  // PR 列表/详情:列表视为 30s 内新鲜,gcTime≈7d 作为保留窗口(替代原手写 maxAge),',
      '  // meta.persist 交由官方 persister 持久化(替代原手写的 localStorage 缓存)。',
    ),
    replace: L(
      '  // PR 列表/详情:列表视为 30s 内新鲜,gcTime≈7d 作为缓存保留窗口,',
      '  // meta.persist 交由官方 persister 持久化。',
    ),
  },
  {
    file: 'src/store/git.ts',
    find: L(
      '  // file baseline 查询：按文件路径寻址，文件被修改后需刷新，',
      '  // 交由 vue-query 的 fetchQuery 去重 + removeQueries 失效，替代手写缓存 + pending 表。',
    ),
    replace: L(
      '  // file baseline 查询：按文件路径寻址，文件被修改后需刷新，',
      '  // 交由 vue-query 的 fetchQuery 去重 + removeQueries 失效。',
    ),
  },
  {
    file: 'src/store/git.ts',
    find: L(
      '  // file baseline 已迁入 vue-query：fetchQuery 自动去重同 key 请求，',
      '  // staleTime=Infinity 命中即复用。文件被修改后由 invalidateFileBaseline 调 removeQueries 失效。',
    ),
    replace: L(
      '  // file baseline 由 vue-query 承载：fetchQuery 自动去重同 key 请求，',
      '  // staleTime=Infinity 命中即复用。文件被修改后由 invalidateFileBaseline 调 removeQueries 失效。',
    ),
  },

  // ── src/store/git-pull-request-helpers.ts ──────────────────────────
  {
    file: 'src/store/git-pull-request-helpers.ts',
    find: L(
      '/**',
      ' * PR 域的纯函数与 vue-query 接线常量。',
      ' *',
      ' * 这些内容从 src/store/git.ts 抽离,目的是:',
      ' * 1) 缩小 git.ts,使其能在单次编辑中可靠地全量重写;',
      ' * 2) 为 PR 列表/详情迁移到 @tanstack/vue-query 提供统一的 query key 与保留窗口。',
      ' *',
      ' * 注意:这里不包含任何手写 localStorage 持久化逻辑——迁移后由 vue-query',
      ' * 的官方 persister(见 src/lib/query-client.ts)统一承担缓存/gc/持久化。',
      ' */',
    ),
    replace: L(
      '/**',
      ' * PR 域的纯函数与 vue-query 接线常量。',
      ' *',
      ' * 独立成模块:把无副作用的 PR 纯函数与查询常量从 git store 的状态逻辑中解耦,',
      ' * 便于单测,并为 PR 列表/详情统一 vue-query 的 query key 与缓存保留窗口。',
      ' *',
      ' * 缓存/gc/持久化均由 vue-query 的官方 persister(见 src/lib/query-client.ts)统一承担,',
      ' * 本模块不含任何手写 localStorage 持久化逻辑。',
      ' */',
    ),
  },
  {
    file: 'src/store/git-pull-request-helpers.ts',
    find: '/** PR 缓存保留窗口(gcTime):未被订阅后保留 7 天,与原手写持久化的 maxAge 保持一致。 */',
    replace: '/** PR 缓存保留窗口(gcTime):未被任何查询订阅后,缓存再保留 7 天才回收。 */',
  },
  {
    file: 'src/store/git-pull-request-helpers.ts',
    find: '/** 后台预加载与并发参数(产品逻辑,与缓存实现无关,保留)。 */',
    replace: '/** 后台预加载与并发参数:属于产品行为,与缓存实现无关。 */',
  },

  // ── src/store/aiAgent.ts ───────────────────────────────────────────
  {
    file: 'src/store/aiAgent.ts',
    find: '// store 与 source 同型,逐字段赋值改成 Object.assign,避免后续加字段时漏同步。',
    replace: '// store 与 source 同型,用 Object.assign 整体赋值,避免新增字段时漏同步。',
  },
  {
    file: 'src/store/aiAgent.ts',
    find: L(
      '        // store 上额外挂的 method / getter 在 .object() 默认 strip 行为下会被忽略,',
      '        // 不必再手工 picking 31 个字段拼对象。',
    ),
    replace: L(
      '        // store 上额外挂的 method / getter 在 .object() 默认 strip 行为下会被忽略,',
      '        // 因此可直接对整个 store 解析,无需手工挑出各持久化字段拼对象。',
    ),
  },

  // ── src/utils/editor/document-metrics.ts ───────────────────────────
  {
    file: 'src/utils/editor/document-metrics.ts',
    find: L(
      ' * 取代旧实现里每次按键都会执行的',
      " *   content.split('\\n').length   // 分配整篇行数组",
      " *   Array.from(content).length   // 分配整篇码点数组",
      ' * 这两个调用都会在整篇文档上分配大数组，大文件 + 高频输入时造成明显的 GC 压力。',
      ' * 这里改为一次遍历、零额外数组分配。',
    ),
    replace: L(
      ' * 手写单次遍历，而非 content.split / Array.from：',
      ' * 后两者会在整篇文档上各分配一个大数组，大文件 + 高频输入时造成明显的 GC 压力，',
      ' * 本实现单次遍历、零额外数组分配。',
    ),
  },
  {
    file: 'src/utils/editor/document-metrics.ts',
    find: ' * 语义保持与旧实现完全一致：',
    replace: ' * 计数口径：',
  },
];

let applied = 0;
let skipped = 0;
const buffers = new Map();

for (const e of edits) {
  if (!buffers.has(e.file)) buffers.set(e.file, readFileSync(e.file, 'utf8'));
  const text = buffers.get(e.file);
  const count = text.split(e.find).length - 1;
  if (count !== 1) {
    console.warn(`[skip] ${e.file}: 命中 ${count} 次（期望 1），跳过该条。`);
    skipped++;
    continue;
  }
  buffers.set(e.file, text.replace(e.find, e.replace));
  applied++;
  console.log(`[ok]   ${e.file}`);
}

for (const [file, text] of buffers) writeFileSync(file, text, 'utf8');
console.log(`\n完成：应用 ${applied} 条，跳过 ${skipped} 条。`);
process.exit(skipped > 0 ? 1 : 0);