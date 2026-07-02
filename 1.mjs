// scripts/fix-p6-permission-options.mjs   用法：node 1.mjs
// P6：ACP 审批公示全部四种标准 PermissionOptionKind（原本只给 once 两项）。
//   - allow_always / reject_always 的"记住不再问"按 ACP 约定由客户端持久化；
//     本 Agent 只负责公示 + 裁决当前这一次（allow*→approve, reject*→reject），零新增状态、无假层。
// regex 锚点容忍 tab/空格/CRLF；按文件实际 EOL 生成；已应用则幂等跳过；硬锚点缺失即报错退出。
import { readFile, writeFile } from "node:fs/promises"

const nlOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n")
const hit = (m, t) => (m == null ? false : m instanceof RegExp ? m.test(t) : t.includes(m))

async function patchFile(path, buildEdits) {
  let text = await readFile(path, "utf8")
  const NL = nlOf(text)
  for (const { regex, replace, marker, label, soft } of buildEdits(NL)) {
    if (hit(marker, text)) { console.log(`↳ 跳过（已应用）：${label}`); continue }
    if (!regex.test(text)) {
      const msg = `未找到锚点：${label}\n   文件：${path}`
      if (soft) { console.warn(`⚠️ ${msg}（软跳过，不影响功能）`); continue }
      console.error(`❌ ${msg}`); process.exit(1)
    }
    text = text.replace(regex, replace)
    console.log(`✅ ${label}`)
  }
  await writeFile(path, text, "utf8")
}

await patchFile("builtin-agent/src/acp/approval-bridge.ts", (NL) => [
  {
    label: "(E1) 新增 allow-always / reject-always 稳定 optionId",
    marker: "APPROVAL_OPTION_ALLOW_ALWAYS =",
    regex: /export const APPROVAL_OPTION_REJECT = "reject-once" as const/,
    replace:
      `export const APPROVAL_OPTION_REJECT = "reject-once" as const${NL}` +
      `export const APPROVAL_OPTION_ALLOW_ALWAYS = "allow-always" as const${NL}` +
      `export const APPROVAL_OPTION_REJECT_ALWAYS = "reject-always" as const`,
  },
  {
    label: "(E2) allow-always 计入放行集合（当前这次按 approve 裁决）",
    marker: /APPROVAL_OPTION_ALLOW_ONCE,\s*APPROVAL_OPTION_ALLOW_ALWAYS,/,
    regex: /(new Set<string>\(\[\s*APPROVAL_OPTION_ALLOW_ONCE,)/,
    replace: `$1${NL}\tAPPROVAL_OPTION_ALLOW_ALWAYS,`,
  },
  {
    label: "(E3a) 公示 allow_always 选项",
    marker: `kind: "allow_always"`,
    regex: /(\{ optionId: APPROVAL_OPTION_ALLOW_ONCE, name: "允许", kind: "allow_once" \},)/,
    replace: `$1${NL}\t\t{ optionId: APPROVAL_OPTION_ALLOW_ALWAYS, name: "始终允许", kind: "allow_always" },`,
  },
  {
    label: "(E3b) 公示 reject_always 选项",
    marker: `kind: "reject_always"`,
    regex: /(\{ optionId: APPROVAL_OPTION_REJECT, name: "拒绝", kind: "reject_once" \},)/,
    replace: `$1${NL}\t\t{ optionId: APPROVAL_OPTION_REJECT_ALWAYS, name: "始终拒绝", kind: "reject_always" },`,
  },
  {
    label: "(E4) 更正过时注释（原称只给两项 / 不做永久允许）",
    soft: true,
    marker: "按 ACP 标准公示全部四种",
    regex: /也不臆造「永久允许」策略。\s*\* 仅提供「允许一次 \/ 拒绝」两个选项。/,
    replace:
      `按 ACP 标准公示全部四种 PermissionOptionKind（allow_once / allow_always / reject_once / reject_always）。${NL}` +
      ` * "始终"类选项的记忆按 ACP 约定由客户端持久化；本 Agent 只公示选项并裁决当前这一次（allow*→approve、reject*→reject）。`,
  },
])

console.log("➡️ 跑一遍 `pnpm -C builtin-agent tsc`（确认 SDK 的 PermissionOptionKind 接受 allow_always/reject_always——ACP 标准四值，应通过）。")