// fix-ai-review-batch-1-resume.mjs  (v2: 兼容 Windows CRLF)
// 全部步骤幂等，可安全重复运行。在仓库根目录执行：
//   node fix-ai-review-batch-1-resume.mjs
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const root = process.cwd();
const read = (rel) => readFileSync(join(root, rel), "utf8");
const write = (rel, s) => writeFileSync(join(root, rel), s);

function replaceUnique(rel, oldStr, newStr, label) {
  const s = read(rel);
  const n = s.split(oldStr).length - 1;
  if (n === 0) throw new Error(`未找到锚点: ${label} @ ${rel}`);
  if (n > 1) throw new Error(`锚点出现 ${n} 次(应唯一): ${label} @ ${rel}`);
  write(rel, s.replace(oldStr, newStr));
  console.log(`[fix] ${label}`);
}

// ── A1：移除已提交的运行时 SQLite 工件（幂等）──────────────────
const SIDECAR_DIR = "builtin-agent/.agent-sidecar";
try {
  execSync(`git rm -r --cached --ignore-unmatch "${SIDECAR_DIR}"`, {
    cwd: root,
    stdio: "inherit",
  });
  console.log("[ok] A1: git 索引已确保移除 " + SIDECAR_DIR);
} catch (e) {
  console.log("[warn] A1: git rm 跳过(" + (e?.message ?? e) + ")");
}
if (existsSync(join(root, SIDECAR_DIR))) {
  rmSync(join(root, SIDECAR_DIR), { recursive: true, force: true });
  console.log("[fix] A1: 已删除本地陈旧目录 " + SIDECAR_DIR);
} else {
  console.log("[skip] A1: 本地目录已不存在");
}
{
  const gi = ".gitignore";
  const rule = "builtin-agent/.agent-sidecar/";
  let c = existsSync(join(root, gi)) ? read(gi) : "";
  if (c.split(/\r?\n/).some((l) => l.trim() === rule)) {
    console.log("[skip] A1: .gitignore 规则已存在");
  } else {
    if (c.length && !c.endsWith("\n")) c += "\n";
    c += rule + "\n";
    write(gi, c);
    console.log("[fix] A1: 已写入 .gitignore 规则");
  }
}

// ── A2：DEFAULT_MODEL_ID 去重（config.ts 导出 + agent.ts 引用）──
{
  const rel = "builtin-agent/src/models/config.ts";
  const s = read(rel);
  if (s.includes("export const DEFAULT_MODEL_ID")) {
    console.log("[skip] A2: config.ts 已导出 DEFAULT_MODEL_ID");
  } else {
    replaceUnique(
      rel,
      "const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-pro';",
      "export const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-pro';",
      "A2: config.ts 导出 DEFAULT_MODEL_ID",
    );
  }
}
{
  const rel = "builtin-agent/src/acp/agent.ts";
  let s = read(rel);
  const eol = s.includes("\r\n") ? "\r\n" : "\n"; // 探测换行符，兼容 CRLF
  // (a) 插入 import（单行锚点，避免依赖换行符）
  if (s.includes('from "../models/config.js"')) {
    console.log("[skip] A2: agent.ts 已 import DEFAULT_MODEL_ID");
  } else {
    const anchorLine =
      'import { resolveAgentModelCapabilitiesFromModelId } from "../models/capabilities.js"';
    const n = s.split(anchorLine).length - 1;
    if (n !== 1) throw new Error(`agent.ts import 锚点应唯一，实际 ${n} 次`);
    s = s.replace(
      anchorLine,
      anchorLine + eol + 'import { DEFAULT_MODEL_ID } from "../models/config.js"',
    );
    write(rel, s);
    console.log("[fix] A2: agent.ts 已插入 import DEFAULT_MODEL_ID");
  }
  // (b) 删除本地重复常量及其（现已过时的）注释
  s = read(rel);
  const constLine = 'const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-pro"';
  if (!s.includes(constLine)) {
    console.log("[skip] A2: agent.ts 本地常量已移除");
  } else {
    const commentLine =
      "/** 默认模型标识——镜像 models/config.ts 的 DEFAULT_MODEL_ID，用于解析上下文窗口。 */";
    const block = commentLine + eol + constLine + eol + eol; // 连同其后空行一并删除
    const n = s.split(block).length - 1;
    if (n !== 1) throw new Error(`agent.ts 本地常量块锚点应唯一，实际 ${n} 次`);
    s = s.replace(block, "");
    write(rel, s);
    console.log("[fix] A2: agent.ts 已移除本地重复常量");
  }
}

// ── A4：isOpenAiReasoningModel 收紧前缀匹配（o + 数字）──────────
{
  const rel = "builtin-agent/src/models/capabilities.ts";
  const s = read(rel);
  if (s.includes("/^o\\d/u.test(id)")) {
    console.log("[skip] A4: capabilities.ts 已收紧匹配");
  } else {
    replaceUnique(
      rel,
      "  return id.startsWith('o') || id.startsWith('gpt-5');",
      "  return /^o\\d/u.test(id) || id.startsWith('gpt-5');",
      "A4: capabilities.ts 收紧 OpenAI 推理模型匹配",
    );
  }
}

console.log(
  "\n全部完成。建议执行：pnpm -C builtin-agent typecheck && pnpm -C builtin-agent test",
);