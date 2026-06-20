// patch9-kimi-code-home-and-openai-provider.mjs
// 修复 Kimi Code(ACP) 鉴权：KIMI_HOME→KIMI_CODE_HOME(新版唯一认的目录覆盖变量)、
// provider 类型 openai_legacy→openai(新版合法的 OpenAI Chat Completions 类型)。
// 依据：kimi.com 官方文档 configuration/env-vars(KIMI_CODE_HOME，无 KIMI_HOME)
// 与 configuration/providers(第三方 OpenAI 兼容服务用 type="openai")。
// 幂等：两处均为全局 token 替换，已替换则 no-op。EOL 保持原状。

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), "src-tauri", "src", "acp", "provisioner.rs");

const raw = readFileSync(FILE, "utf8");
const usedCrlf = raw.includes("\r\n");
let text = usedCrlf ? raw.replace(/\r\n/g, "\n") : raw;

// ── 前置校验：确认是预期文件版本（任一锚点存在即认为命中目标文件）──
const hasOldEnv = text.includes("KIMI_HOME");
const hasOldType = text.includes("openai_legacy");
const alreadyDone =
  text.includes("KIMI_CODE_HOME") &&
  text.includes('type = "openai"') &&
  !hasOldEnv &&
  !hasOldType;

if (alreadyDone) {
  console.log("✓ 已是修复后状态（KIMI_CODE_HOME + openai），无需改动。");
  process.exit(0);
}

if (!hasOldEnv && !hasOldType) {
  console.error(
    "✗ 未找到 KIMI_HOME / openai_legacy 锚点；文件可能与预期版本不一致，已中止且未写入。",
  );
  process.exit(1);
}

// ── 替换 1：KIMI_HOME → KIMI_CODE_HOME ──
// 命中：常量名 KIMI_HOME_ENV→KIMI_CODE_HOME_ENV、字面量 "KIMI_HOME"→"KIMI_CODE_HOME"、
//      及全部注释。注意 "KIMI_HOME" 不是 "KIMI_CODE_HOME" 的子串，幂等安全；
//      "kimi-home"(小写托管目录名) / KIMI_API_KEY / KIMI_MANAGED_HOME_DIR 均不受影响（大小写/分词不同）。
const envCount = (text.match(/KIMI_HOME/g) || []).length;
text = text.split("KIMI_HOME").join("KIMI_CODE_HOME");

// ── 替换 2：openai_legacy → openai ──
// 命中：render_kimi_config_toml 的 type 字段、注释、单测断言。新版 type 合法值为 openai。
const typeCount = (text.match(/openai_legacy/g) || []).length;
text = text.split("openai_legacy").join("openai");

// ── 写回（恢复原 EOL）──
const out = usedCrlf ? text.replace(/\n/g, "\r\n") : text;
writeFileSync(FILE, out, "utf8");

console.log(
  `✓ 修复完成：KIMI_HOME→KIMI_CODE_HOME ×${envCount}，openai_legacy→openai ×${typeCount}`,
);
console.log("  下一步：重新 cargo build，重启应用，再用 Agent 模式发一条消息验证。");