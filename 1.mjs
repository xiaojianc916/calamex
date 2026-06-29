#!/usr/bin/env node
// scripts/search-count-perf-fix.mjs
//
// 一次性脚本：优化查找面板计数（countSearchMatches / refreshCount）。
// total 只随「查询」或「文档内容」变化重算；纯移动光标(selectionSet)时 CM 复用同一个
// doc 实例，据此复用缓存的 total，省掉一次全文扫描，current 用提前退出扫描。
//
// 用法：node scripts/search-count-perf-fix.mjs   （仓库根目录运行）
// 安全性：每个锚点必须「恰好命中 1 次」，否则不写入、非零退出。用完即删。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE = "src/components/editor/CodeMirrorScriptEditor.vue";

// ── Edit 1：移除顶层 countSearchMatches（逻辑并入面板内的 refreshCount）──
const ANCHOR_1 = [
  "const countSearchMatches = (",
  "  view: EditorView,",
  "  query: SearchQuery,",
  "): { total: number; current: number } => {",
  "  if (!query.valid) return { total: 0, current: 0 };",
  "  const main = view.state.selection.main;",
  "  let total = 0;",
  "  let current = 0;",
  "  const cursor = query.getCursor(view.state);",
  "  while (!cursor.next().done) {",
  "    total += 1;",
  "    if (cursor.value.from === main.from && cursor.value.to === main.to) current = total;",
  "  }",
  "  return { total, current };",
  "};",
].join("\n");

const REPLACE_1 = [
  "// countSearchMatches 已并入 createSearchPanel 内的 refreshCount 计数缓存逻辑：",
  "// total（命中总数）只随查询或文档内容变化重算，纯移动光标时复用缓存，避免每次全文扫描。",
].join("\n");

// ── Edit 2：替换 refreshCount，加入计数缓存 + 提前退出 ──
const ANCHOR_2 = [
  "  const refreshCount = (): void => {",
  "    const query = getSearchQuery(view.state);",
  "    if (!query.search) {",
  "      count.textContent = '';",
  "      return;",
  "    }",
  "    const { total, current } = countSearchMatches(view, query);",
  "    count.textContent = total === 0 ? '无结果' : `${current || '–'}/${total}`;",
  "  };",
].join("\n");

const REPLACE_2 = [
  "  // 计数缓存：total 只随「查询」或「文档内容」变化重算。CM 在纯移动光标(selectionSet)时",
  "  // 复用同一个 doc 实例，doc 引用不变即说明内容没变，可直接复用上次 total，省掉一次全文扫描——",
  "  // 查找框打开期间每次按键 / 移动光标都会触发 update→refreshCount，故大文件里收益明显。",
  "  let cachedTotal = 0;",
  "  let cachedTotalKey: string | null = null;",
  "  let cachedTotalDoc: unknown = null;",
  "",
  "  const buildCountKey = (query: SearchQuery): string =>",
  "    JSON.stringify([query.search, query.caseSensitive, query.regexp, query.wholeWord]);",
  "",
  "  // current（光标所在第几个命中）：数到命中即停的提前退出扫描，命中靠前时远比扫到文末便宜。",
  "  const resolveCurrentMatchIndex = (query: SearchQuery): number => {",
  "    const main = view.state.selection.main;",
  "    let index = 0;",
  "    const cursor = query.getCursor(view.state);",
  "    while (!cursor.next().done) {",
  "      index += 1;",
  "      if (cursor.value.from === main.from && cursor.value.to === main.to) return index;",
  "    }",
  "    return 0;",
  "  };",
  "",
  "  const refreshCount = (): void => {",
  "    const query = getSearchQuery(view.state);",
  "    if (!query.search || !query.valid) {",
  "      count.textContent = '';",
  "      cachedTotal = 0;",
  "      cachedTotalKey = null;",
  "      cachedTotalDoc = null;",
  "      return;",
  "    }",
  "    const key = buildCountKey(query);",
  "    if (key !== cachedTotalKey || view.state.doc !== cachedTotalDoc) {",
  "      // 查询或文档内容变化：全量重算，并在同一遍里顺带定位 current，避免两遍扫描。",
  "      const main = view.state.selection.main;",
  "      let total = 0;",
  "      let current = 0;",
  "      const cursor = query.getCursor(view.state);",
  "      while (!cursor.next().done) {",
  "        total += 1;",
  "        if (cursor.value.from === main.from && cursor.value.to === main.to) current = total;",
  "      }",
  "      cachedTotal = total;",
  "      cachedTotalKey = key;",
  "      cachedTotalDoc = view.state.doc;",
  "      count.textContent = total === 0 ? '无结果' : `${current || '–'}/${total}`;",
  "      return;",
  "    }",
  "    // 缓存命中（纯移动光标）：total 复用，仅用提前退出扫描定位 current。",
  "    const current = cachedTotal === 0 ? 0 : resolveCurrentMatchIndex(query);",
  "    count.textContent = cachedTotal === 0 ? '无结果' : `${current || '–'}/${cachedTotal}`;",
  "  };",
].join("\n");

const EDITS = [
  { anchor: ANCHOR_1, replacement: REPLACE_1 },
  { anchor: ANCHOR_2, replacement: REPLACE_2 },
];

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

if (src.includes("cachedTotalDoc")) {
  console.log("• 已检测到补丁（cachedTotalDoc 已存在），跳过。");
  process.exit(0);
}

// 先全部校验锚点唯一，再统一写入：任一锚点异常都不落盘。
let out = src;
for (const [i, { anchor }] of EDITS.entries()) {
  const count = out.split(anchor).length - 1;
  if (count !== 1) {
    fail(`Edit ${i + 1} 锚点命中 ${count} 次（期望 1 次），文件可能已变动，未写入任何改动。`);
  }
}
for (const { anchor, replacement } of EDITS) {
  out = out.replace(anchor, replacement);
}
if (out === src) fail("替换后内容无变化，已中止（不应发生）。");

writeFileSync(path, out, "utf8");
console.log(`\x1b[32m✓ 已优化 ${FILE} 的查找计数（total 缓存 + current 提前退出）\x1b[0m`);
console.log("  接下来：git diff → pnpm build → 删除本脚本 → 提交到 main");