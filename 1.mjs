// scripts/fix-p5-locations.mjs   用法：node 1.mjs
// P5（locations 部分）：文件类工具调用向 ACP 上报 locations，客户端可"跟随"AI 正在操作的文件。
//   路径取自工具输入参数（复用仓库已有 extractWorkspaceToolPathInput），不依赖工具结果结构 —— 全程可取证。
//   diff 部分不在本脚本：其 old/new 文本依赖 @mastra/core/workspace 的结果 schema（在 node_modules、不在仓库），
//   不取证不写，避免经验主义。
// 锚点用 \s 容忍 tab/空格/CRLF；替换按各文件实际 EOL 生成；已应用则幂等跳过；锚点缺失大声报错不静默改坏。
import { readFile, writeFile } from "node:fs/promises"

const nlOf = (t) => (t.includes("\r\n") ? "\r\n" : "\n")

async function patchFile(path, buildEdits) {
  let text = await readFile(path, "utf8")
  const NL = nlOf(text)
  for (const { regex, replace, marker, label } of buildEdits(NL)) {
    if (marker && text.includes(marker)) { console.log(`↳ 跳过（已应用）：${label}`); continue }
    if (!regex.test(text)) { console.error(`❌ 未找到锚点：${label}\n   文件：${path}`); process.exit(1) }
    text = text.replace(regex, replace)
    console.log(`✅ ${label}`)
  }
  await writeFile(path, text, "utf8")
}

// ---- (A/B) base.ts：导入 helper + started 事件从输入参数派生 locations ----
await patchFile("builtin-agent/src/engines/runtime/base.ts", (NL) => [
  {
    label: "base.ts (A) 导入 extractWorkspaceToolPathInput",
    marker: "destroyMastraWorkspace, extractWorkspaceToolPathInput",
    regex: /destroyMastraWorkspace(\s*\}\s*from\s*['"]\.\.\/workspace\/workspace\.js['"];)/,
    replace: `destroyMastraWorkspace, extractWorkspaceToolPathInput$1`,
  },
  {
    label: "base.ts (B1) 从输入参数解析文件路径",
    marker: "const toolLocationPath = extractWorkspaceToolPathInput",
    regex: /(const inputPreview = createWorkspaceRuntimeInputPreview\(\s*chunk\.payload\.toolName,\s*chunk\.payload\.args,\s*\);)/,
    replace: `$1${NL}                    const toolLocationPath = extractWorkspaceToolPathInput(chunk.payload.args);`,
  },
  {
    label: "base.ts (B2) started 事件挂 locations",
    marker: "locations: [{ path: toolLocationPath }]",
    regex: /(\.\.\.\(inputPreview\s*\?\s*\{\s*inputPreview\s*\}\s*:\s*\{\}\),)/,
    replace: `$1${NL}                        ...(toolLocationPath ? { locations: [{ path: toolLocationPath }] } : {}),`,
  },
])

// ---- (C) stream-types.ts：新增 IAgentToolLocation 类型 + started 事件 locations 字段 ----
await patchFile("builtin-agent/src/streaming/stream-types.ts", (NL) => [
  {
    label: "stream-types.ts (C1) 新增 IAgentToolLocation 类型",
    marker: "export interface IAgentToolLocation",
    regex: /export interface IAgentToolStartedEvent extends IAgentRuntimeEventBase \{/,
    replace:
      `export interface IAgentToolLocation {${NL}  path: string;${NL}  line?: number;${NL}}${NL}${NL}` +
      `export interface IAgentToolStartedEvent extends IAgentRuntimeEventBase {`,
  },
  {
    label: "stream-types.ts (C2) started 事件新增 locations 字段",
    marker: "locations?: IAgentToolLocation[]",
    regex: /(export interface IAgentToolStartedEvent extends IAgentRuntimeEventBase \{[\s\S]*?inputPreview\?: string;)/,
    replace: `$1${NL}  locations?: IAgentToolLocation[];`,
  },
])

// ---- (D) from-runtime-event.ts：投影层把 locations 映射到 ACP tool_call（tab 缩进，靠 \s 匹配 + \t 生成）----
await patchFile("builtin-agent/src/acp/from-runtime-event.ts", (NL) => [
  {
    label: "from-runtime-event.ts (D) tool_call 携带 locations",
    marker: "{ locations: event.locations }",
    regex: /(status:\s*"in_progress",\s*\.\.\.\(event\.inputPreview\s*!==\s*undefined\s*\?\s*\{\s*rawInput:\s*event\.inputPreview\s*\}\s*:\s*\{\}\),)/,
    replace: `$1${NL}\t\t\t\t\t...(event.locations && event.locations.length > 0${NL}\t\t\t\t\t\t? { locations: event.locations }${NL}\t\t\t\t\t\t: {}),`,
  },
])

console.log("➡️ 跑一遍 `pnpm -C builtin-agent tsc`（尤其确认 ACP SessionUpdate 的 tool_call 接受 locations 字段——按 ACP schema 应当接受）。")