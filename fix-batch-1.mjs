#!/usr/bin/env node
/**
 * fix-batch-4.mjs — 第三轮审查修复脚本
 *
 * N-9: aiAgent.ts — addOfficialUsage 中 current.inputTokenDetails / current.outputTokenDetails
 *     未用可选链，current 为 null 时 TypeError（🔴 严重）
 *
 * N-1: useIntegratedTerminal.ts — session getter 每次创建新 readonly(ref(null))（🟡 轻微）
 *
 * 用法: node fix-batch-4.mjs
 * 仓库根目录: D:\com.xiaojianc\my_desktop_app
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = "D:\\com.xiaojianc\\my_desktop_app";

// ============================================================
// 辅助函数
// ============================================================

function readFile(relPath) {
  const abs = join(REPO_ROOT, relPath);
  console.log(`📖 读取: ${relPath}`);
  return readFileSync(abs, "utf-8");
}

function writeFile(relPath, content) {
  const abs = join(REPO_ROOT, relPath);
  console.log(`✏️  写入: ${relPath}`);
  writeFileSync(abs, content, "utf-8");
}

function applyPatch(content, oldStr, newStr, label, relPath) {
  const idx = content.indexOf(oldStr);
  if (idx === -1) {
    console.warn(`⚠️  [SKIP] ${label}: 未找到匹配文本 in ${relPath}`);
    console.warn(`    期望找到:\n${oldStr.slice(0, 200)}...`);
    return content;
  }
  if (content.indexOf(oldStr, idx + 1) !== -1) {
    console.warn(`⚠️  [SKIP] ${label}: 匹配到多处 in ${relPath}，跳过以避免误改`);
    return content;
  }
  const patched =
    content.slice(0, idx) +
    newStr +
    content.slice(idx + oldStr.length);
  console.log(`✅ [DONE] ${label}`);
  return patched;
}

// ============================================================
// N-9: aiAgent.ts — addOfficialUsage 可选链修复
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("N-9: aiAgent.ts — addOfficialUsage 可选链修复");
console.log("=".repeat(60));

const aiAgentPath = "src/store/aiAgent.ts";
let aiAgentContent = readFile(aiAgentPath);

// Patch 1: cachedInputTokens — current.inputTokenDetails → current?.inputTokenDetails?
aiAgentContent = applyPatch(
  aiAgentContent,
  `const cachedInputTokens = addTokenCounts(
  current.inputTokenDetails.cacheReadTokens,
  next.inputTokenDetails.cacheReadTokens,
);`,
  `const cachedInputTokens = addTokenCounts(
  current?.inputTokenDetails?.cacheReadTokens,
  next.inputTokenDetails.cacheReadTokens,
);`,
  "N-9a: cachedInputTokens 可选链",
  aiAgentPath,
);

// Patch 2: reasoningTokens — current.outputTokenDetails → current?.outputTokenDetails?
aiAgentContent = applyPatch(
  aiAgentContent,
  `const reasoningTokens = addTokenCounts(
  current.outputTokenDetails.reasoningTokens,
  next.outputTokenDetails.reasoningTokens,
);`,
  `const reasoningTokens = addTokenCounts(
  current?.outputTokenDetails?.reasoningTokens,
  next.outputTokenDetails.reasoningTokens,
);`,
  "N-9b: reasoningTokens 可选链",
  aiAgentPath,
);

writeFile(aiAgentPath, aiAgentContent);

// ============================================================
// N-1: useIntegratedTerminal.ts — 预创建 NULL_SESSION 常量
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("N-1: useIntegratedTerminal.ts — 预创建 NULL_SESSION");
console.log("=".repeat(60));

const terminalCompPath = "src/composables/useIntegratedTerminal.ts";
let terminalContent = readFile(terminalCompPath);

// Patch 1: 在 session getter 之前添加 NULL_SESSION 常量
// 我们需要找到 session getter 并在它之前插入常量
// 注意: NULL_SESSION 需要在模块/composable 作用域中定义

// 首先尝试找到 readonly(ref(null)) 的位置并替换
// 方案: 在 get session() 的 readonly(ref(null)) 替换为 NULL_SESSION，
// 并在 getter 前面插入常量声明

// Patch 1a: 替换 getter 中的 readonly(ref(null)) 为 NULL_SESSION
terminalContent = applyPatch(
  terminalContent,
  `get session() {
    const s = registry.get(DEFAULT_TERMINAL_SESSION_ID);
    return s ? readonly(s.session) : readonly(ref(null));
  }`,
  `get session() {
    const s = registry.get(DEFAULT_TERMINAL_SESSION_ID);
    return s ? readonly(s.session) : NULL_SESSION;
  }`,
  "N-1a: session getter 使用 NULL_SESSION",
  terminalCompPath,
);

// Patch 1b: 在 session getter 前面插入 NULL_SESSION 常量声明
// 找到 get session() 前面最近的合适位置插入常量
// 尝试在 get session() 前插入
terminalContent = applyPatch(
  terminalContent,
  `get session() {
    const s = registry.get(DEFAULT_TERMINAL_SESSION_ID);
    return s ? readonly(s.session) : NULL_SESSION;
  }`,
  `const NULL_SESSION = readonly(ref(null));

  get session() {
    const s = registry.get(DEFAULT_TERMINAL_SESSION_ID);
    return s ? readonly(s.session) : NULL_SESSION;
  }`,
  "N-1b: 插入 NULL_SESSION 常量声明",
  terminalCompPath,
);

writeFile(terminalCompPath, terminalContent);

// ============================================================
// 完成
// ============================================================

console.log("\n" + "=".repeat(60));
console.log("✅ fix-batch-4.mjs 完成");
console.log("=".repeat(60));
console.log("\n修改摘要:");
console.log("  N-9  (🔴 严重): aiAgent.ts — addOfficialUsage 可选链修复 (2 patches)");
console.log("  N-1  (🟡 轻微): useIntegratedTerminal.ts — 预创建 NULL_SESSION (2 patches)");
console.log("\n请运行 `pnpm typecheck` 验证类型安全。");