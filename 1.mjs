// fix-remove-dead-redaction-module.mjs
// 根治 #2：删除无人调用、且范式不符合行业标杆的 redaction 脱敏模块（死代码）。
//   - 删除 src-tauri/src/ai/security/redaction.rs
//   - 从 src-tauri/src/ai/security/mod.rs 摘除 `pub mod redaction;`
// 在仓库根目录运行：node fix-remove-dead-redaction-module.mjs
// 幂等：重复运行不报错。CRLF 安全。

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

const REDACTION_FILE = "src-tauri/src/ai/security/redaction.rs";
const MOD_FILE = "src-tauri/src/ai/security/mod.rs";

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// 1) 删除 redaction.rs
if (existsSync(REDACTION_FILE)) {
  rmSync(REDACTION_FILE);
  console.log(`✓ 已删除 ${REDACTION_FILE}`);
} else {
  console.log(`• ${REDACTION_FILE} 不存在，跳过（幂等）`);
}

// 2) 从 mod.rs 摘除 `pub mod redaction;`
if (!existsSync(MOD_FILE)) fail(`未找到 ${MOD_FILE}`);

const original = readFileSync(MOD_FILE, "utf8");
const eol = original.includes("\r\n") ? "\r\n" : "\n";
const lines = original.split(/\r?\n/);

const isRedactionModLine = (line) => line.trim() === "pub mod redaction;";
const matches = lines.filter(isRedactionModLine).length;

if (matches === 0) {
  console.log(`• ${MOD_FILE} 已无 \`pub mod redaction;\`，跳过（幂等）`);
} else if (matches > 1) {
  fail(`${MOD_FILE} 出现 ${matches} 处 \`pub mod redaction;\`，预期恰好 1 处，中止以免误删`);
} else {
  const kept = lines.filter((line) => !isRedactionModLine(line));
  writeFileSync(MOD_FILE, kept.join(eol), "utf8");
  console.log(`✓ 已从 ${MOD_FILE} 摘除 \`pub mod redaction;\``);
}

// 3) 残留校验
const after = existsSync(MOD_FILE) ? readFileSync(MOD_FILE, "utf8") : "";
if (/\bredaction\b/.test(after)) fail(`${MOD_FILE} 仍残留 redaction 引用，请人工检查`);

console.log("✓ 完成：redaction 模块已根除");