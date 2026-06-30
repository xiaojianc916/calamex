// 1.mjs — ④ Slice B-builtin：删除自家边车（builtin-agent）的 session/set_mode
//   - acp/agent.ts             删 setSessionMode 方法 + 连带失效的导入/辅助/doc
//   - acp/agent.spec.ts        模式路由用例改投 setSessionConfigOption(configId:"mode")
//   - acp/mode-config-options.ts  模块 doc 去除 session/set_mode 历史措辞
//   - acp/session-registry.ts     setMode() 的 doc 改标为 set_config_option(mode)
// 唯一标准管线 = session/set_config_option（mode 作为官方 SessionConfigOption）
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

const ROOT = process.cwd()
const toLf = (s) => s.replace(/\r\n/g, "\n")
const t = (...lines) => lines.join("\n")

function replaceOnce(c, oldStr, newStr, label) {
	const i = c.indexOf(oldStr)
	if (i === -1) throw new Error("[中止] 锚点未找到:" + label)
	if (c.indexOf(oldStr, i + oldStr.length) !== -1)
		throw new Error("[中止] 锚点不唯一:" + label)
	return c.slice(0, i) + newStr + c.slice(i + oldStr.length)
}
const present = (c, tok, label) => {
	if (!c.includes(tok)) throw new Error("[中止] 自检失败(应保留):" + label + " · " + tok)
}
const absent = (c, tok, label) => {
	if (c.includes(tok)) throw new Error("[中止] 自检失败(应删除):" + label + " · " + tok)
}

// ───────────────────────────── 1) builtin-agent/src/acp/agent.ts ─────────────────────────────
function editAgentTs(c) {
	// A 模块 doc：把 setSessionMode 项改写为标准 setSessionConfigOption 项
	c = replaceOnce(c,
		" * - setSessionMode    → 校验 modeId 为 TAgentMode 后切换该会话运行模式。",
		" * - setSessionConfigOption → 校验 configId/value 后切换该会话的模式或模型(官方唯一配置管线)。",
		"agent.ts/模块doc")
	// B SDK 导入：去 SetSessionModeRequest / SetSessionModeResponse
	c = replaceOnce(c,
		t("\ttype SetSessionConfigOptionRequest,",
		  "\ttype SetSessionConfigOptionResponse,",
		  "\ttype SetSessionModeRequest,",
		  "\ttype SetSessionModeResponse,",
		  '} from "@agentclientprotocol/sdk"'),
		t("\ttype SetSessionConfigOptionRequest,",
		  "\ttype SetSessionConfigOptionResponse,",
		  '} from "@agentclientprotocol/sdk"'),
		"agent.ts/SDK导入")
	// C runtime-input 导入：AGENT_MODES 连带失效，仅留 TAgentMode 类型
	c = replaceOnce(c,
		t("import {",
		  "\tAGENT_MODES,",
		  "\ttype TAgentMode,",
		  '} from "../engines/contracts/runtime-input.js"'),
		'import type { TAgentMode } from "../engines/contracts/runtime-input.js"',
		"agent.ts/runtime-input导入")
	// D isAgentMode 辅助（仅 setSessionMode 使用，连带删除）
	c = replaceOnce(c,
		t("/** modeId 是否为合法的运行时模式。 */",
		  "const isAgentMode = (value: string): value is TAgentMode =>",
		  "\t(AGENT_MODES as readonly string[]).includes(value)",
		  "",
		  ""),
		"",
		"agent.ts/isAgentMode")
	// E setSessionMode 方法本体（标准 session/set_mode 处理器，整体删除）
	c = replaceOnce(c,
		t("\tasync setSessionMode(",
		  "\t\tparams: SetSessionModeRequest,",
		  "\t): Promise<SetSessionModeResponse> {",
		  "\t\tif (!isAgentMode(params.modeId)) {",
		  "\t\t\tthrow RequestError.invalidParams(",
		  "\t\t\t\t{ modeId: params.modeId, allowed: AGENT_MODES },",
		  "\t\t\t\t`非法会话模式：${params.modeId}`,",
		  "\t\t\t)",
		  "\t\t}",
		  "\t\tconst state = this.registry.setMode(params.sessionId, params.modeId)",
		  "\t\tif (!state) {",
		  "\t\t\tthrow sessionNotFound(params.sessionId)",
		  "\t\t}",
		  "\t\treturn {}",
		  "\t}",
		  "",
		  ""),
		"",
		"agent.ts/setSessionMode方法")
	absent(c, "setSessionMode", "agent.ts")
	absent(c, "SetSessionMode", "agent.ts")
	absent(c, "isAgentMode", "agent.ts")
	absent(c, "AGENT_MODES", "agent.ts")
	present(c, "setSessionConfigOption", "agent.ts")
	present(c, "applyModeConfigOption", "agent.ts")
	present(c, "MODE_CONFIG_OPTION_ID", "agent.ts")
	present(c, "buildModeConfigOption", "agent.ts")
	return c
}

// ───────────────────────────── 2) builtin-agent/src/acp/agent.spec.ts ─────────────────────────────
function editAgentSpecTs(c) {
	// 模式路由用例改投官方 set_config_option(configId="mode")，保留 plan→chat 断言
	c = replaceOnce(c,
		t('test("setSessionMode 拒绝非法模式,接受合法模式并路由到对应 runtime 方法", async () => {',
		  "\tconst { connection } = recordingConnection()",
		  "\tconst calls: string[] = []",
		  "\tconst runtime = makeRuntime(",
		  "\t\tasync (input) => {",
		  '\t\t\tcalls.push("execute")',
		  '\t\t\treturn { sessionId: input.sessionId ?? "", events: [], result: null }',
		  "\t\t},",
		  "\t\t{",
		  "\t\t\tchat: async (input) => {",
		  '\t\t\t\tcalls.push("chat")',
		  '\t\t\t\treturn { sessionId: input.sessionId ?? "", events: [], result: null }',
		  "\t\t\t},",
		  "\t\t\tplan: async (input) => {",
		  '\t\t\t\tcalls.push("plan")',
		  '\t\t\t\treturn { sessionId: input.sessionId ?? "", events: [], result: null }',
		  "\t\t\t},",
		  "\t\t},",
		  "\t)",
		  "\tconst agent = new CalamexAcpAgent(connection, runtime)",
		  '\tconst { sessionId } = await agent.newSession({ cwd: "/w", mcpServers: [] })',
		  "\tawait assert.rejects(() =>",
		  '\t\tagent.setSessionMode({ sessionId, modeId: "bogus" }),',
		  "\t)",
		  '\tawait agent.setSessionMode({ sessionId, modeId: "plan" })',
		  '\tawait agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })',
		  '\tawait agent.setSessionMode({ sessionId, modeId: "ask" })',
		  '\tawait agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })',
		  '\tassert.deepEqual(calls, ["plan", "chat"])',
		  "})"),
		t('test("set_config_option(mode) 拒绝非法模式,接受合法模式并路由到对应 runtime 方法", async () => {',
		  "\tconst { connection } = recordingConnection()",
		  "\tconst calls: string[] = []",
		  "\tconst runtime = makeRuntime(",
		  "\t\tasync (input) => {",
		  '\t\t\tcalls.push("execute")',
		  '\t\t\treturn { sessionId: input.sessionId ?? "", events: [], result: null }',
		  "\t\t},",
		  "\t\t{",
		  "\t\t\tchat: async (input) => {",
		  '\t\t\t\tcalls.push("chat")',
		  '\t\t\t\treturn { sessionId: input.sessionId ?? "", events: [], result: null }',
		  "\t\t\t},",
		  "\t\t\tplan: async (input) => {",
		  '\t\t\t\tcalls.push("plan")',
		  '\t\t\t\treturn { sessionId: input.sessionId ?? "", events: [], result: null }',
		  "\t\t\t},",
		  "\t\t},",
		  "\t)",
		  "\tconst agent = new CalamexAcpAgent(connection, runtime)",
		  '\tconst { sessionId } = await agent.newSession({ cwd: "/w", mcpServers: [] })',
		  "\tawait assert.rejects(() =>",
		  '\t\tagent.setSessionConfigOption({ sessionId, configId: "mode", value: "bogus" }),',
		  "\t)",
		  '\tawait agent.setSessionConfigOption({ sessionId, configId: "mode", value: "plan" })',
		  '\tawait agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })',
		  '\tawait agent.setSessionConfigOption({ sessionId, configId: "mode", value: "ask" })',
		  '\tawait agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })',
		  '\tassert.deepEqual(calls, ["plan", "chat"])',
		  "})"),
		"agent.spec.ts/模式路由用例")
	absent(c, "setSessionMode", "agent.spec.ts")
	present(c, "setSessionConfigOption", "agent.spec.ts")
	present(c, 'configId: "mode"', "agent.spec.ts")
	present(c, 'assert.deepEqual(calls, ["plan", "chat"])', "agent.spec.ts")
	return c
}

// ───────────────────────── 3) builtin-agent/src/acp/mode-config-options.ts ─────────────────────────
function editModeConfigOptionsTs(c) {
	// 模块 doc：去除 session/set_mode 的「将被移除」历史措辞，改述现行唯一配置管线
	c = replaceOnce(c,
		t(" * ACP 的 session/set_mode 已被官方标注为将在未来版本移除，由 session config options 统一",
		  " * 取代（见 protocol/session-config-options）。本模块据此把用户可选的运行模式（ask / plan /",
		  " * agent）公示为官方 SessionConfigOption（category=mode），经 session/set_config_option",
		  ' * (configId="mode") 切换，与模型选择器（category=model）同构，构成唯一的会话配置管线。'),
		t(" * 运行模式由官方 session config options 统一管理（见 protocol/session-config-options）：本模块把",
		  " * 用户可选的运行模式（ask / plan / agent）公示为官方 SessionConfigOption（category=mode），经",
		  ' * session/set_config_option (configId="mode") 切换，与模型选择器（category=model）同构，',
		  " * 构成唯一的会话配置管线。"),
		"mode-config-options.ts/模块doc")
	absent(c, "session/set_mode", "mode-config-options.ts")
	present(c, "session/set_config_option", "mode-config-options.ts")
	present(c, "MODE_CONFIG_OPTION_ID", "mode-config-options.ts")
	return c
}

// ───────────────────────── 4) builtin-agent/src/acp/session-registry.ts ─────────────────────────
function editSessionRegistryTs(c) {
	// 模块 doc 列表：setMode() 的触发由 session/set_mode 改标为 set_config_option(mode)
	c = replaceOnce(c,
		" * - session/set_mode → setMode()：切换已登记会话的运行模式。",
		" * - set_config_option(mode) → setMode()：切换已登记会话的运行模式。",
		"session-registry.ts/模块doc")
	absent(c, "session/set_mode", "session-registry.ts")
	present(c, "setMode", "session-registry.ts")
	return c
}

// ============================================================
// 驱动：读 → 改 → 各文件自检 → 全局残留扫描 → 全绿才落盘（LF）
// ============================================================
const SRC_DIR = join(ROOT, "builtin-agent", "src")

const TARGETS = [
	{ rel: "builtin-agent/src/acp/agent.ts", edit: editAgentTs },
	{ rel: "builtin-agent/src/acp/agent.spec.ts", edit: editAgentSpecTs },
	{ rel: "builtin-agent/src/acp/mode-config-options.ts", edit: editModeConfigOptionsTs },
	{ rel: "builtin-agent/src/acp/session-registry.ts", edit: editSessionRegistryTs },
]

// 边车侧 session/set_mode 禁词（子串）；config-option 命名不含这些子串，安全
const FORBIDDEN = ["setSessionMode", "SetSessionMode", "session/set_mode"]

// 1) 读 + 改 + 文件级自检，改后内容先留内存
const transformed = new Map()
for (const { rel, edit } of TARGETS) {
	const abs = join(ROOT, rel)
	const original = toLf(readFileSync(abs, "utf8"))
	const next = edit(original)
	if (next === original) {
		throw new Error(`[中止] 空改动:${rel} · 锚点已失效或文件已处理`)
	}
	transformed.set(rel, next)
}

// 2) 全局残留扫描：builtin-agent/src/** 全部 .ts（已编辑文件用改后内容覆盖比对）
function walkTs(dir) {
	const out = []
	for (const name of readdirSync(dir)) {
		const abs = join(dir, name)
		const st = statSync(abs)
		if (st.isDirectory()) out.push(...walkTs(abs))
		else if (name.endsWith(".ts")) out.push(abs)
	}
	return out
}

const residual = []
for (const abs of walkTs(SRC_DIR)) {
	const rel = relative(ROOT, abs).split(sep).join("/")
	const text = transformed.has(rel)
		? transformed.get(rel)
		: toLf(readFileSync(abs, "utf8"))
	text.split("\n").forEach((line, i) => {
		for (const tok of FORBIDDEN) {
			if (line.includes(tok)) {
				residual.push(`${rel}:${i + 1} · ${tok} · ${line.trim()}`)
				break
			}
		}
	})
}

if (residual.length > 0) {
	throw new Error(
		"[中止] 仍有 session/set_mode 残留（未写盘）：\n" + residual.join("\n"),
	)
}

// 3) 全绿 → 落盘（统一 LF）
for (const { rel } of TARGETS) {
	writeFileSync(join(ROOT, rel), transformed.get(rel), "utf8")
}

console.log(`✓ B-builtin 完成：已删除边车 session/set_mode，写盘 ${TARGETS.length} 个文件`)
for (const { rel } of TARGETS) console.log("  - " + rel)