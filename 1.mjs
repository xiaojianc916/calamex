#!/usr/bin/env node
/**
 * scripts/scroll-smoothness-fix.mjs
 *
 * 一次性脚本：进一步优化编辑器「上下滑动」的丝滑度。
 *
 * 背景：codemirror-shiki-highlight.ts 的 renderViewportFromCache 每个 viewportChanged
 * 帧都按「视口 ± DECORATION_RENDER_MARGIN_LINES(8)」算渲染范围。滚动时该范围逐行平移，
 * decorationCacheKey 每帧都变 → 每帧用 RangeSetBuilder 重建整屏装饰，与浏览器滚动/绘制
 * 抢主线程，造成「沉重、不跟手」。
 *
 * 优化：把装饰渲染范围的上下沿块对齐到 DECORATION_RENDER_CHUNK_LINES(64) 边界。同一块内
 * 滚动时渲染范围（及缓存 key）不变 → 命中 decorationCache 直接复用，逐帧零重建；仅跨块时
 * 重建一次（覆盖 1~2 块）。token 着色与正确性不变。
 *
 * 用法（在仓库根目录 D:\com.xiaojianc\my_desktop_app 下）：
 *   node scripts/scroll-smoothness-fix.mjs
 * 然后：git diff 审查 → pnpm build 验证 → 删除本脚本 → 提交并推送 main。
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = process.cwd();
const TARGET = path.join(REPO_ROOT, "src/services/editor/codemirror-shiki-highlight.ts");

const lines = (...xs) => xs.join("\n");

function replaceOnce(src, label, oldStr, newStr) {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    throw new Error(
      `[scroll-smoothness-fix] 锚点「${label}」期望命中 1 处，实际 ${count} 处。` +
        `文件可能已变更，请重新生成脚本后再运行（未写入任何改动）。`,
    );
  }
  return src.replace(oldStr, newStr);
}

async function main() {
  let src = await readFile(TARGET, "utf8");

  if (src.includes("DECORATION_RENDER_CHUNK_LINES")) {
    console.log("[scroll-smoothness-fix] 已检测到 DECORATION_RENDER_CHUNK_LINES，跳过（幂等）。");
    return;
  }

  // —— 编辑 1：新增块对齐粒度常量 ——
  const anchor1 = lines(
    "// DecorationSet 只需要覆盖真实视口附近。",
    "// token 预取/缓存范围可以大，但 RangeSetBuilder 不应为大量屏幕外行重复创建 Decoration。",
    "const DECORATION_RENDER_MARGIN_LINES = 8;",
  );
  const replacement1 = lines(
    anchor1,
    "",
    "// 装饰渲染范围的块对齐粒度（行）。renderViewportFromCache 把「视口 ± margin」的上下沿分别",
    "// 向下/向上对齐到该块边界，使在同一块内滚动时渲染范围（及其缓存 key）保持不变 → 直接命中",
    "// decorationCache 复用，免去逐帧 RangeSetBuilder 重建（上下滑动丝滑的关键）；仅跨块时重建",
    "// 一次（覆盖 1~2 块）。取 64 在「每帧零重建」与「跨块单次重建体积」之间取得平衡。",
    "const DECORATION_RENDER_CHUNK_LINES = 64;",
  );
  src = replaceOnce(src, "新增 DECORATION_RENDER_CHUNK_LINES 常量", anchor1, replacement1);

  // —— 编辑 2：renderViewportFromCache 渲染范围块对齐 ——
  const anchor2 = lines(
    "      const renderRange = computeShikiHighlightRange({",
    "        firstVisibleLine: visible.first,",
    "        lastVisibleLine: visible.last,",
    "        totalLines: view.state.doc.lines,",
    "        overscanLines: DECORATION_RENDER_MARGIN_LINES,",
    "        leadInLines: DECORATION_RENDER_MARGIN_LINES,",
    "        fromDocumentStart: false,",
    "      });",
  );
  const replacement2 = lines(
    "      const totalLines = view.state.doc.lines;",
    "      const rawRange = computeShikiHighlightRange({",
    "        firstVisibleLine: visible.first,",
    "        lastVisibleLine: visible.last,",
    "        totalLines,",
    "        overscanLines: DECORATION_RENDER_MARGIN_LINES,",
    "        leadInLines: DECORATION_RENDER_MARGIN_LINES,",
    "        fromDocumentStart: false,",
    "      });",
    "      // 把渲染范围上下沿对齐到块边界：同一块内滚动时 renderRange 不变 → 下方 decorationCache",
    "      // 直接命中复用，逐帧零重建装饰（上下滑动丝滑的关键）；仅跨块时重建一次。",
    "      const renderBlock = DECORATION_RENDER_CHUNK_LINES;",
    "      const renderRange = {",
    "        startLine: Math.max(1, Math.floor((rawRange.startLine - 1) / renderBlock) * renderBlock + 1),",
    "        endLine: Math.min(totalLines, Math.ceil(rawRange.endLine / renderBlock) * renderBlock),",
    "      };",
  );
  src = replaceOnce(src, "renderViewportFromCache 渲染范围块对齐", anchor2, replacement2);

  await writeFile(TARGET, src, "utf8");
  console.log("[scroll-smoothness-fix] 已写入 2 处改动：");
  console.log("  1) 新增 DECORATION_RENDER_CHUNK_LINES = 64");
  console.log("  2) renderViewportFromCache 渲染范围块对齐（逐帧零重建装饰）");
  console.log("请运行 `git diff` 审查，`pnpm build` 验证，确认后删除本脚本并提交推送 main。");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});