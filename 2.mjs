// polish-comments-batch2.mjs  —  在仓库根目录 node polish-comments-batch2.mjs
import { readFileSync, writeFileSync } from 'node:fs';

/** 每条都来自当前 main 源码逐字复制；命中必须恰好 1 次。 */
const EDITS = [
  // ── src/composables/useShellWorkbenchView.ts ──────────────────────────────
  {
    file: 'src/composables/useShellWorkbenchView.ts',
    find: `  /**
   * 按 Git status letter 精确分类统计文件变更数。
   *
   * 修复：此前 gitRemovedCount 恒为 0（写死），且 gitAddedCount 把 modified
   * 文件也算进了「新增」。现在直接遍历 status.files 数组按 index/worktree
   * status 分类：A=新增、D=删除、M/R=修改、?=未跟踪。
   */`,
    replace: `  /**
   * 按 Git status letter 精确分类统计文件变更数：遍历 status.files，按 index /
   * worktree status 归类——A=新增、D=删除、M/R=修改、?=未跟踪。
   */`,
  },
  {
    file: 'src/composables/useShellWorkbenchView.ts',
    find: `      // 性能优化：切换 AI/编辑模式时不要强制改写终端可见性。
      // 终端是否可见属于“编辑模式布局状态”，强制写 false 会触发主界面分支切换`,
    replace: `      // 切换 AI/编辑模式时不要强制改写终端可见性：
      // 终端是否可见属于“编辑模式布局状态”，强制写 false 会触发主界面分支切换`,
  },
  {
    file: 'src/composables/useShellWorkbenchView.ts',
    find: `      // 注意：这里不再强制 openEditorMode。仅切换 activeDocumentId（切换已打开的标签、
      // 文档前进后退）不应强制切到编辑模式；“新打开并激活文档”才进编辑模式的逻辑
      // 已下沉到 documents watch（依据旧值快照判定是否新增了文档）。`,
    replace: `      // 仅切换 activeDocumentId（切换已打开的标签、文档前进后退）不强制切到编辑模式；
      // “新打开并激活文档”才进编辑模式的逻辑下沉在 documents watch（依据旧值快照判定是否新增文档）。`,
  },
  {
    file: 'src/composables/useShellWorkbenchView.ts',
    find: `  // ── documents 变更 watch ──────────────────────────────────────
  // 优化前：getter 返回 .map(item => item.id) → 每次 Vue 脏检查时分配新数组；
  // 回调里再 new Set() x2 做 diff。
  // 优化后：getter 返回 length + activeDocumentId 组合值（两个原始值拼接为字符串），
  // 只有文档数量或 activeDocumentId 变化时 Vue 才判定为"变化"并触发回调。
  // 回调内部直接访问最新 documents 数组构建当前 ID Set，与上一轮缓存的
  // previousDocumentIdSet 做 diff，避免在 getter 中分配新数组。`,
    replace: `  // ── documents 变更 watch ──────────────────────────────────────
  // getter 返回 length 与 activeDocumentId 拼接的字符串：仅当文档数量或 activeDocumentId
  // 变化时才触发回调，避免在 getter 中用 .map() 分配新数组。回调内基于最新 documents
  // 构建当前 ID Set，与上一轮缓存的 previousDocumentIdSet 做 diff。`,
  },
  {
    file: 'src/composables/useShellWorkbenchView.ts',
    find: `      // 切换已打开标签 / 前进后退不会新增文档，因此不会再被强制切到编辑模式
      //（修复 activeDocumentId 变化即强制 openEditorMode 的回归）。`,
    replace: `      // 切换已打开标签 / 前进后退不会新增文档，因此不会被强制切到编辑模式。`,
  },

  // ── src/store/app.ts ──────────────────────────────────────────────────────
  {
    file: 'src/store/app.ts',
    find: `import { clampInt } from '@/utils/core/math'; // [round3] clampInt`,
    replace: `import { clampInt } from '@/utils/core/math';`,
  },
  {
    file: 'src/store/app.ts',
    find: `// [round3] prototype check: more precise than toString.call, excludes class instances`,
    replace: `// 用原型链判断纯对象：比 toString.call 更精确，可排除 class 实例。`,
  },
  {
    file: 'src/store/app.ts',
    find: `  // [round3] clampInt: reuse math.ts unified implementation`,
    replace: `  // 复用 math.ts 的 clampInt 统一实现。`,
  },
  {
    file: 'src/store/app.ts',
    find: `  // 关键修复:item 可能是损坏的 null / 非对象,先做形状校验再访问 .id。`,
    replace: `  // item 可能是损坏的 null / 非对象,先做形状校验再访问 .id。`,
  },

  // ── src/store/git.ts ──────────────────────────────────────────────────────
  {
    file: 'src/store/git.ts',
    find: `  // commit-stats 的权威缓存在 vue-query;同步读取直接调 queryClient.getQueryData。
  // 已移除冗余的 commitStatsCache ref 镜像——vue-query 的 cacheObservable 已驱动 UI 更新。`,
    replace: `  // commit-stats 的权威缓存在 vue-query;同步读取直接调 queryClient.getQueryData,
  // 由 vue-query 的 cacheObservable 驱动 UI 更新。`,
  },
  {
    file: 'src/store/git.ts',
    find: `      // requestIdleCallback 的 timeout 参数保证回调最终一定执行，
      // 不需要额外加 setTimeout fallback（原双层超时是冗余的防御）。`,
    replace: `      // requestIdleCallback 的 timeout 参数保证回调最终一定执行，
      // 因此不需要额外的 setTimeout fallback。`,
  },

  // ── src/services/tauri.ipc-define.ts ──────────────────────────────────────
  {
    file: 'src/services/tauri.ipc-define.ts',
    find: `/**
 * 单条 Tauri 命令的声明式包装元数据。
 *
 * 把原先散落在各 service 方法字面量里的 command / guardHint / timeout / audit /
 * measureInput / measureOutput / errorMap 等固定字段集中成「可审计的常量表」，
 * 运行期行为与手写 callSpectaCommand 完全一致——不新增 schema 校验，也不改变任何默认值。
 */`,
    replace: `/**
 * 单条 Tauri 命令的声明式包装元数据：把 command / guardHint / timeout / audit /
 * measureInput / measureOutput / errorMap 等固定字段集中为「可审计的常量表」，
 * 供 runCommand 统一驱动 callSpectaCommand。
 */`,
  },
];

let failed = 0;
const byFile = new Map();
for (const e of EDITS) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)).push(e);

for (const [file, edits] of byFile) {
  let text = readFileSync(file, 'utf8');
  for (const { find, replace } of edits) {
    const n = text.split(find).length - 1;
    if (n !== 1) {
      console.error(`✗ ${file}: 命中 ${n} 次（应为 1），跳过该条:\n${find.slice(0, 60)}...`);
      failed++;
      continue;
    }
    text = text.replace(find, replace);
  }
  writeFileSync(file, text, 'utf8');
  console.log(`✓ ${file}`);
}
process.exit(failed ? 1 : 0);