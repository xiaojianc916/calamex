#!/usr/bin/env node
// fix-p2a-cleanup-refs.mjs
// P2-a 收尾：清理 schemaVersion 删除后残留的两处引用。
// 1) ext-methods.model-chat.spec.ts —— 真实编译/测试断裂：删 import + 删 schemaVersion 断言。
// 2) stream-types.ts —— 注释里的悬挂引用（非 import，不断编译）：改写注释，消除对已删符号的指向。
// CRLF 安全、幂等、未命中即 exit(1)。
// 用法：node fix-p2a-cleanup-refs.mjs [仓库根目录，默认 cwd]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const SPEC = join(ROOT, "builtin-agent/src/acp/ext-methods.model-chat.spec.ts");
const STREAM = join(ROOT, "builtin-agent/src/streaming/stream-types.ts");

const detectEol = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

function load(p) {
  if (!existsSync(p)) {
    console.error(`❌ 找不到文件：${p}\n   请在仓库根目录运行，或把根目录作为第一个参数传入。`);
    process.exit(1);
  }
  const raw = readFileSync(p, "utf8");
  return { eol: detectEol(raw), text: raw.replace(/\r\n/g, "\n") };
}

function removeOnce(text, regex, { label, alreadyGone }) {
  if (regex.test(text)) return { text: text.replace(regex, ""), note: `✂️  ${label}` };
  if (alreadyGone(text)) return { text, note: `↻ 已移除（幂等跳过）：${label}` };
  console.error(`❌ 未命中且非幂等状态：${label}\n   源文件行文/缩进可能已变，请人工核对。`);
  process.exit(1);
}

function replaceOnce(text, needle, replacement, { label }) {
  if (text.includes(needle)) return { text: text.replace(needle, replacement), note: `✏️  ${label}` };
  if (text.includes(replacement)) return { text, note: `↻ 已改写（幂等跳过）：${label}` };
  console.error(`❌ 未命中且非幂等状态：${label}\n   源文件行文可能已变，请人工核对。`);
  process.exit(1);
}

function edit(p, transforms) {
  const { text, eol } = load(p);
  let cur = text;
  const notes = [];
  for (const t of transforms) { const r = t(cur); cur = r.text; notes.push(r.note); }
  if (cur !== text) writeFileSync(p, cur.replace(/\n/g, eol), "utf8");
  console.log(`${cur !== text ? "✅ 已更新" : "ℹ️  无变化"} ${relative(ROOT, p)}`);
  notes.forEach((n) => console.log(`   ${n}`));
}

// ---- 1) spec 文件：删 import + 删断言 ----
edit(SPEC, [
  (t) =>
    removeOnce(
      t,
      /import \{ BUILTIN_AGENT_RESPONSE_SCHEMA_VERSION \} from "\.\.\/schemas\/events\.js"\n/,
      {
        label: "spec：删除 BUILTIN_AGENT_RESPONSE_SCHEMA_VERSION 的 import",
        alreadyGone: (x) => !/import \{ BUILTIN_AGENT_RESPONSE_SCHEMA_VERSION \}/.test(x),
      },
    ),
  (t) =>
    removeOnce(
      t,
      /[ \t]*assert\.equal\(result\.schemaVersion, BUILTIN_AGENT_RESPONSE_SCHEMA_VERSION\)\n/,
      {
        label: "spec：删除 result.schemaVersion 断言",
        alreadyGone: (x) => !x.includes("result.schemaVersion"),
      },
    ),
]);

// ---- 2) stream-types.ts：改写悬挂注释 ----
edit(STREAM, [
  (t) =>
    replaceOnce(
      t,
      ' * 不是 UI wire envelope（后者由 `events.ts.BUILTIN_AGENT_RESPONSE_SCHEMA_VERSION` 管）。',
      ' * 不是 UI wire envelope（信封本身已无独立协议版本字段）。',
      { label: "stream-types：改写指向已删符号的注释" },
    ),
]);

console.log("\n完成。接着跑：pnpm -C builtin-agent tsc（类型校验）。");