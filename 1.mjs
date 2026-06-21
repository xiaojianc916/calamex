// remove-dead-lsp-types.mjs
// 用途：删除 src-tauri/Cargo.toml 中未被任何 .rs 引用的死依赖 lsp-types。
// 安全性：仅匹配 [dependencies] 下形如 `lsp-types = ...` 的整行；幂等；不动其它内容。
// 运行（仓库根目录）：node remove-dead-lsp-types.mjs
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/Cargo.toml";
const src = readFileSync(FILE, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
const lines = src.split(/\r?\n/);

// 只删行首即 `lsp-types =` 的依赖声明行（容忍空白），不波及注释/其它键。
const idx = lines.findIndex((l) => /^\s*lsp-types\s*=/.test(l));

if (idx === -1) {
  console.log("✓ 未发现 lsp-types 依赖行，无需改动（幂等）。");
  process.exit(0);
}

console.log(`- 删除第 ${idx + 1} 行: ${lines[idx].trim()}`);
lines.splice(idx, 1);
writeFileSync(FILE, lines.join(eol), "utf8");
console.log("✓ 已从 Cargo.toml 删除 lsp-types。");