#!/usr/bin/env node
// fix-run2-missing-prompt.mjs
// 根因:extract_prompt_from_terminal_snapshot 的起点锚点在整个 prefix 上 rfind ANSI 颜色码,
// 会被上一次运行输出里的绿色/加粗序列劫持,使第二次提取 prompt 失败返回 None
//(表现:第一次运行正常、第二次只剩空白行+光标)。改为只回溯到 marker 所在行行首。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/terminal/visual.rs";

// 正则元字符转义(用于把字面代码块拼进正则)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 旧代码块(纯 ASCII,与文件逐字一致)
const OLD_CODE = [
  "    let start = prefix",
  '        .rfind("\\x1b[32m")',
  '        .or_else(|| prefix.rfind("\\x1b[1m"))',
  "        .or_else(|| prefix.rfind('\\n').map(|i| i + 1))",
  "        .or_else(|| prefix.rfind('\\r').map(|i| i + 1))",
  "        .unwrap_or(0);",
].join("\n");

// 新注释 + 新代码
const REPLACE = [
  "    // 锚点只回溯到 marker 所在行的行首:shell prompt 总位于其所在行行首。",
  "    // 旧实现在整个 prefix 上 rfind ANSI 颜色码,会被更早输出(如上一次运行的绿色日志)里的",
  "    // 颜色码劫持起点,再 split 到下一个换行,取到一行不含 $/# 的输出而提取失败 —— 即",
  "    // 「第一次运行正常、第二次只剩空白行+光标」。行内锚点同时完整保留 prompt 自身颜色码。",
  "    let start = prefix",
  "        .rfind('\\n')",
  "        .map(|i| i + 1)",
  "        .or_else(|| prefix.rfind('\\r').map(|i| i + 1))",
  "        .unwrap_or(0);",
].join("\n");

const raw = readFileSync(FILE, "utf8");

// 幂等:旧颜色码锚点已不存在 => 已修复
if (!raw.includes('.rfind("\\x1b[32m")')) {
  console.log(`[skip] ${FILE} 已修复,无需改动。`);
  process.exit(0);
}

const usesCrlf = raw.includes("\r\n");
const lf = usesCrlf ? raw.replace(/\r\n/g, "\n") : raw;

// 吞掉紧贴在旧代码块上方的任意注释行(标点无关) + 旧代码块
const FIND_RE = new RegExp("(?:[ \\t]*//[^\\n]*\\n)*" + esc(OLD_CODE), "g");

const occurrences = (lf.match(FIND_RE) || []).length;
if (occurrences !== 1) {
  console.error(`[fail] 期望恰好 1 处匹配,实际 ${occurrences} 处。未改动 ${FILE}。`);
  process.exit(1);
}

// 用函数形式替换,避免 REPLACE 里的 $ 被当成替换模式
const nextLf = lf.replace(FIND_RE, () => REPLACE);
const out = usesCrlf ? nextLf.replace(/\n/g, "\r\n") : nextLf;
writeFileSync(FILE, out, "utf8");
console.log(`[ok] 已修复 ${FILE}:prompt 提取改为 line-local 锚点。`);