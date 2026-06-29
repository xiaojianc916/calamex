#!/usr/bin/env node
// scripts/inline-completion-perf-fix.mjs
//
// 一次性脚本：修复行内补全 clearGhost 的「空事务」性能问题。
// clearGhost 原本无条件 dispatch，导致每次打字(docChanged)与每次移动光标(selectionSet)
// 即便没有 ghost 也会空跑一个事务，触发全量 update 循环。改为仅在确有 ghost 装饰时才派发。
//
// 用法：node scripts/inline-completion-perf-fix.mjs
// 安全性：锚点必须在文件中「恰好命中 1 次」，否则不写入、非零退出。
// 用完即删，再 git diff / pnpm build / 提交到 main。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = "src/services/editor/codemirror-inline-completion.ts";

const ANCHOR =
  "  const clearGhost = (): void => {\n" +
  "    viewRef?.dispatch({ effects: setInlineCompletionGhost.of(null) });\n" +
  "  };";

const REPLACEMENT =
  "  const clearGhost = (): void => {\n" +
  "    const view = viewRef;\n" +
  "    if (!view) {\n" +
  "      return;\n" +
  "    }\n" +
  "    // 仅在确有 ghost 装饰时才派发清除事务；否则纯打字 / 移动光标（每次 docChanged 与\n" +
  "    // selectionSet 都会调用本函数）都会空跑一个事务，触发全量 update 循环。\n" +
  "    const ghost = view.state.field(inlineCompletionGhostField, false);\n" +
  "    if (!ghost || ghost.size === 0) {\n" +
  "      return;\n" +
  "    }\n" +
  "    view.dispatch({ effects: setInlineCompletionGhost.of(null) });\n" +
  "  };";

function fail(msg) {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

const path = resolve(process.cwd(), FILE);

let src;
try {
  src = readFileSync(path, "utf8");
} catch (err) {
  fail(`读不到文件：${FILE}（请在仓库根目录运行）\n  ${err.message}`);
}

// 幂等：已改过就跳过，避免重复运行报错。
if (src.includes("const ghost = view.state.field(inlineCompletionGhostField, false);")) {
  console.log("• 已检测到补丁，无需重复应用，跳过。");
  process.exit(0);
}

// 锚点必须恰好命中 1 次。
const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  fail(
    `锚点在 ${FILE} 中命中 ${count} 次（期望 1 次），文件可能已变动。\n` +
      `  未写入任何改动。请重新核对 clearGhost 当前源码后再生成锚点。`,
  );
}

const out = src.replace(ANCHOR, REPLACEMENT);
if (out === src) {
  fail("替换后内容无变化，已中止（不应发生）。");
}

writeFileSync(path, out, "utf8");
console.log(`\x1b[32m✓ 已修补 ${FILE}（clearGhost 现仅在有 ghost 时派发清除事务）\x1b[0m`);
console.log("  接下来：git diff → pnpm build → 删除本脚本 → 提交到 main");