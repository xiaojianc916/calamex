#!/usr/bin/env node
// ============================================================================
// Slice A1（建 · builtin）：把「模式」并入官方 session config options 唯一管线
// ----------------------------------------------------------------------------
// 仅改 builtin-agent。先建不删：
//   · 新增 mode-config-options.ts：把 ask/plan/agent 公示为官方 SessionConfigOption
//     （category="mode"），与模型选择器（category="model"）同构。
//   · agent.ts：newSession 同时公示 mode+model 选择器；setSessionConfigOption 改为
//     按 configId 路由（mode→registry.setMode / model→setModelConfig），响应回传
//     完整配置状态（ACP 约定）。
//   · 暂不删 setSessionMode / session/set_mode 旧路（留 Slice B 统一拔除，零兼容层）。
// 运行：node slice-a1-builtin-mode-config-option.mjs
// 校验：pnpm --filter builtin-agent typecheck && pnpm --filter builtin-agent test
// ============================================================================
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const ROOT = process.cwd()
const J = (rel) => path.join(ROOT, rel)
const toLf = (s) => s.replace(/\r\n/g, "\n")
const readText = async (rel) => toLf(await readFile(J(rel), "utf8"))
const t = (...lines) => lines.join("\n")

const replaceOnce = (src, oldStr, newStr, label) => {
	const i = src.indexOf(oldStr)
	if (i === -1) throw new Error("[锚点缺失] " + label)
	if (src.indexOf(oldStr, i + oldStr.length) !== -1)
		throw new Error("[锚点歧义] " + label)
	return src.slice(0, i) + newStr + src.slice(i + oldStr.length)
}

const AGENT = "builtin-agent/src/acp/agent.ts"
const MODE_FILE = "builtin-agent/src/acp/mode-config-options.ts"
const MODE_SPEC = "builtin-agent/src/acp/mode-config-options.spec.ts"

// ---------------------------------------------------------------------------
// 1) 新文件：mode-config-options.ts
// ---------------------------------------------------------------------------
const modeModule = t(
	"/**",
	" * builtin agent 会话级「模式选择器」——官方 session config option（category=mode）。",
	" *",
	" * ACP 的 session/set_mode 已被官方标注为将在未来版本移除，由 session config options 统一",
	" * 取代（见 protocol/session-config-options）。本模块据此把用户可选的运行模式（ask / plan /",
	" * agent）公示为官方 SessionConfigOption（category=mode），经 session/set_config_option",
	' * (configId="mode") 切换，与模型选择器（category=model）同构，构成唯一的会话配置管线。',
	" *",
	" * 纯函数、无状态、无 IO；类型对齐 SDK SessionConfigOption（select 变体）与运行时模式枚举。",
	" */",
	'import type { SessionConfigOption } from "@agentclientprotocol/sdk"',
	"",
	'import type { TAgentMode } from "../engines/contracts/runtime-input.js"',
	"",
	"/** 模式选择器的 config option id（前端按 id 路由 set_config_option）。 */",
	'export const MODE_CONFIG_OPTION_ID = "mode"',
	"",
	"/**",
	" * 用户可选的运行模式（选择器公示的子集）。",
	" * patch / review 是内部派生模式（由 agent 执行管线按任务形态自行采用），不进用户选择器。",
	" * `satisfies` 约束确保这些标识恒为合法的运行时模式（TAgentMode）。",
	" */",
	"export const USER_SELECTABLE_MODES = [",
	'\t"ask",',
	'\t"plan",',
	'\t"agent",',
	"] as const satisfies readonly TAgentMode[]",
	"export type TUserSelectableMode = (typeof USER_SELECTABLE_MODES)[number]",
	"",
	"/** 单个模式的展示文案（name 面向终端用户）。 */",
	"interface IModeDisplay {",
	"\tname: string",
	"}",
	"",
	"const MODE_DISPLAY: Record<TUserSelectableMode, IModeDisplay> = {",
	'\task: { name: "询问" },',
	'\tplan: { name: "计划" },',
	'\tagent: { name: "智能体" },',
	"}",
	"",
	"/** value 是否为用户可选模式（运行时仍可能处于 patch/review 等内部模式）。 */",
	"export const isUserSelectableMode = (",
	"\tvalue: string,",
	"): value is TUserSelectableMode =>",
	"\t(USER_SELECTABLE_MODES as readonly string[]).includes(value)",
	"",
	"/**",
	" * 把会话当前模式落到选择器的 currentValue：用户可选模式直接采用；",
	" * 内部派生模式（patch/review）回退到 agent，使选择器恒有合法当前值。",
	" */",
	"export const resolveCurrentModeValue = (",
	"\tmode: TAgentMode,",
	'): TUserSelectableMode => (isUserSelectableMode(mode) ? mode : "agent")',
	"",
	"/**",
	" * 构造会话级模式选择器（单选 select，category=mode）。",
	" * 形状与模型选择器同构；currentValue 取自会话当前模式，options 为用户可选模式集。",
	" * 恒非空（ask/plan/agent 三项），故每个会话都会公示该选择器。",
	" */",
	"export const buildModeConfigOption = (",
	"\tmode: TAgentMode,",
	"): SessionConfigOption => ({",
	'\ttype: "select",',
	"\tid: MODE_CONFIG_OPTION_ID,",
	'\tname: "模式",',
	'\tcategory: "mode",',
	"\tcurrentValue: resolveCurrentModeValue(mode),",
	"\toptions: USER_SELECTABLE_MODES.map((value) => ({",
	"\t\tvalue,",
	"\t\tname: MODE_DISPLAY[value].name,",
	"\t})),",
	"})",
	"",
)

// ---------------------------------------------------------------------------
// 2) 新文件：mode-config-options.spec.ts（vitest，与 model 规格同风格）
// ---------------------------------------------------------------------------
const modeSpec = t(
	'import { describe, expect, it } from "vitest"',
	"",
	"import {",
	"\tbuildModeConfigOption,",
	"\tisUserSelectableMode,",
	"\tMODE_CONFIG_OPTION_ID,",
	"\tresolveCurrentModeValue,",
	"\tUSER_SELECTABLE_MODES,",
	'} from "./mode-config-options.js"',
	"",
	'describe("isUserSelectableMode", () => {',
	'\tit("仅 ask/plan/agent 为用户可选模式", () => {',
	'\t\texpect(isUserSelectableMode("ask")).toBe(true)',
	'\t\texpect(isUserSelectableMode("plan")).toBe(true)',
	'\t\texpect(isUserSelectableMode("agent")).toBe(true)',
	'\t\texpect(isUserSelectableMode("patch")).toBe(false)',
	'\t\texpect(isUserSelectableMode("review")).toBe(false)',
	'\t\texpect(isUserSelectableMode("bogus")).toBe(false)',
	"\t})",
	"})",
	"",
	'describe("resolveCurrentModeValue", () => {',
	'\tit("用户可选模式原样返回", () => {',
	'\t\texpect(resolveCurrentModeValue("ask")).toBe("ask")',
	'\t\texpect(resolveCurrentModeValue("plan")).toBe("plan")',
	'\t\texpect(resolveCurrentModeValue("agent")).toBe("agent")',
	"\t})",
	'\tit("内部派生模式回退 agent", () => {',
	'\t\texpect(resolveCurrentModeValue("patch")).toBe("agent")',
	'\t\texpect(resolveCurrentModeValue("review")).toBe("agent")',
	"\t})",
	"})",
	"",
	'describe("buildModeConfigOption", () => {',
	'\tit("构造 category=mode 的单选选择器并带当前值与全部可选模式", () => {',
	'\t\texpect(buildModeConfigOption("plan")).toMatchObject({',
	'\t\t\ttype: "select",',
	"\t\t\tid: MODE_CONFIG_OPTION_ID,",
	'\t\t\tcategory: "mode",',
	'\t\t\tcurrentValue: "plan",',
	'\t\t\toptions: [{ value: "ask" }, { value: "plan" }, { value: "agent" }],',
	"\t\t})",
	'\t\texpect(USER_SELECTABLE_MODES).toEqual(["ask", "plan", "agent"])',
	"\t})",
	'\tit("内部派生模式作为当前值时回退 agent", () => {',
	'\t\texpect(buildModeConfigOption("review")).toMatchObject({',
	'\t\t\tcurrentValue: "agent",',
	"\t\t})",
	"\t})",
	"})",
	"",
)

// ---------------------------------------------------------------------------
// 3) 编辑 agent.ts
// ---------------------------------------------------------------------------
let agent = await readText(AGENT)

// A) SDK import：补 SessionConfigOption 类型
agent = replaceOnce(
	agent,
	"\ttype SessionNotification,",
	t("\ttype SessionConfigOption,", "\ttype SessionNotification,"),
	"A: SDK import SessionConfigOption",
)

// B) session-registry import：补 IAcpSessionState 类型
agent = replaceOnce(
	agent,
	'import { AcpSessionRegistry } from "./session-registry.js"',
	t(
		"import {",
		"\tAcpSessionRegistry,",
		"\ttype IAcpSessionState,",
		'} from "./session-registry.js"',
	),
	"B: session-registry import IAcpSessionState",
)

// C) 新增 mode-config-options import（紧跟 model-config-options import 之后）
agent = replaceOnce(
	agent,
	'} from "./model-config-options.js"',
	t(
		'} from "./model-config-options.js"',
		"import {",
		"\tbuildModeConfigOption,",
		"\tisUserSelectableMode,",
		"\tMODE_CONFIG_OPTION_ID,",
		"\tUSER_SELECTABLE_MODES,",
		'} from "./mode-config-options.js"',
	),
	"C: import mode-config-options",
)

// D) newSession：公示 mode+model 完整选择器
agent = replaceOnce(
	agent,
	t(
		"\t\tconst configOptions = buildModelConfigOptions(modelCatalog)",
		"\t\treturn {",
		"\t\t\tsessionId: state.sessionId,",
		"\t\t\t...(configOptions.length > 0 ? { configOptions } : {}),",
		"\t\t}",
	),
	t(
		"\t\t// 会话配置选择器（唯一标准管线）：模式选择器恒公示（ask/plan/agent），模型选择器",
		"\t\t// 在宿主注入模型目录时附加；二者皆为官方 SessionConfigOption，经 set_config_option 切换。",
		"\t\treturn {",
		"\t\t\tsessionId: state.sessionId,",
		"\t\t\tconfigOptions: this.buildSessionConfigOptions(state),",
		"\t\t}",
	),
	"D: newSession configOptions",
)

// E1) setSessionConfigOption：单分支 → 按 configId 路由 + 回传完整状态
agent = replaceOnce(
	agent,
	t(
		"\t\tif (params.configId !== MODEL_CONFIG_OPTION_ID) {",
		"\t\t\tthrow RequestError.invalidParams(",
		"\t\t\t\t{ configId: params.configId, allowed: [MODEL_CONFIG_OPTION_ID] },",
		'\t\t\t\t"未知会话配置项：" + params.configId,',
		"\t\t\t)",
		"\t\t}",
		"\t\tconst catalog = state.modelCatalog",
		"\t\tif (!catalog) {",
		"\t\t\tthrow RequestError.invalidParams(",
		"\t\t\t\t{ sessionId: params.sessionId },",
		'\t\t\t\t"本会话未公示模型选择器（无模型目录）。",',
		"\t\t\t)",
		"\t\t}",
		"\t\t// 模型选择器恒为单选 select，value 为 modelId 字符串；boolean 变体在此不适用。",
		'\t\tconst modelId = typeof params.value === "string" ? params.value : undefined',
		"\t\tconst modelConfig =",
		"\t\t\tmodelId !== undefined ? resolveModelConfigInput(catalog, modelId) : undefined",
		"\t\tif (modelConfig === undefined) {",
		"\t\t\tthrow RequestError.invalidParams(",
		"\t\t\t\t{ configId: params.configId, value: params.value },",
		'\t\t\t\t"非法的模型选择值（不在模型目录中）。",',
		"\t\t\t)",
		"\t\t}",
		"\t\tthis.registry.setModelConfig(params.sessionId, modelConfig)",
		"\t\tconst nextCatalog: IAcpModelCatalog = {",
		"\t\t\tmodels: catalog.models,",
		"\t\t\tcurrentModelId: modelConfig.modelId,",
		"\t\t}",
		"\t\treturn { configOptions: buildModelConfigOptions(nextCatalog) }",
	),
	t(
		"\t\t// 唯一配置管线：按 configId 路由到对应应用器（模式 / 模型）。两者皆为官方",
		"\t\t// SessionConfigOption；未知 configId 一律 invalidParams。",
		"\t\tswitch (params.configId) {",
		"\t\t\tcase MODE_CONFIG_OPTION_ID:",
		"\t\t\t\tthis.applyModeConfigOption(params.sessionId, params.value)",
		"\t\t\t\tbreak",
		"\t\t\tcase MODEL_CONFIG_OPTION_ID:",
		"\t\t\t\tthis.applyModelConfigOption(state, params.value)",
		"\t\t\t\tbreak",
		"\t\t\tdefault:",
		"\t\t\t\tthrow RequestError.invalidParams(",
		"\t\t\t\t\t{",
		"\t\t\t\t\t\tconfigId: params.configId,",
		"\t\t\t\t\t\tallowed: [MODE_CONFIG_OPTION_ID, MODEL_CONFIG_OPTION_ID],",
		"\t\t\t\t\t},",
		'\t\t\t\t\t"未知会话配置项：" + params.configId,',
		"\t\t\t\t)",
		"\t\t}",
		"\t\t// ACP 约定：响应回传完整配置状态（模式 + 模型），前端整体替换选择器状态。",
		"\t\treturn {",
		"\t\t\tconfigOptions: this.buildSessionConfigOptions(",
		"\t\t\t\tthis.registry.get(params.sessionId) ?? state,",
		"\t\t\t),",
		"\t\t}",
	),
	"E1: setSessionConfigOption router",
)

// E2) 在 prompt() 之前插入三个私有辅助方法
const helpers = t(
	"\t/**",
	'\t * 应用模式选择（configId="mode"）：value 必须是用户可选模式（ask/plan/agent），',
	"\t * 回写会话当前模式，下一回合 prompt 即按新模式路由。非法值映射为 invalidParams。",
	"\t */",
	"\tprivate applyModeConfigOption(sessionId: string, value: unknown): void {",
	'\t\tconst mode = typeof value === "string" ? value : undefined',
	"\t\tif (mode === undefined || !isUserSelectableMode(mode)) {",
	"\t\t\tthrow RequestError.invalidParams(",
	"\t\t\t\t{",
	"\t\t\t\t\tconfigId: MODE_CONFIG_OPTION_ID,",
	"\t\t\t\t\tvalue,",
	"\t\t\t\t\tallowed: USER_SELECTABLE_MODES,",
	"\t\t\t\t},",
	'\t\t\t\t"非法的模式选择值。",',
	"\t\t\t)",
	"\t\t}",
	"\t\tthis.registry.setMode(sessionId, mode)",
	"\t}",
	"",
	"\t/**",
	'\t * 应用模型选择（configId="model"）：据所选 modelId 从会话登记的模型目录解析完整模型',
	"\t * 配置（含凭据）回写会话，下一回合 prompt 即生效。会话未公示模型选择器、或值不在目录中",
	"\t * 时映射为 invalidParams。",
	"\t */",
	"\tprivate applyModelConfigOption(",
	"\t\tstate: IAcpSessionState,",
	"\t\tvalue: unknown,",
	"\t): void {",
	"\t\tconst catalog = state.modelCatalog",
	"\t\tif (!catalog) {",
	"\t\t\tthrow RequestError.invalidParams(",
	"\t\t\t\t{ sessionId: state.sessionId },",
	'\t\t\t\t"本会话未公示模型选择器（无模型目录）。",',
	"\t\t\t)",
	"\t\t}",
	"\t\t// 模型选择器恒为单选 select，value 为 modelId 字符串；boolean 变体在此不适用。",
	'\t\tconst modelId = typeof value === "string" ? value : undefined',
	"\t\tconst modelConfig =",
	"\t\t\tmodelId !== undefined ? resolveModelConfigInput(catalog, modelId) : undefined",
	"\t\tif (modelConfig === undefined) {",
	"\t\t\tthrow RequestError.invalidParams(",
	"\t\t\t\t{ configId: MODEL_CONFIG_OPTION_ID, value },",
	'\t\t\t\t"非法的模型选择值（不在模型目录中）。",',
	"\t\t\t)",
	"\t\t}",
	"\t\tthis.registry.setModelConfig(state.sessionId, modelConfig)",
	"\t}",
	"",
	"\t/**",
	"\t * 组装会话当前的完整配置选择器（唯一标准管线）：模式选择器恒在（ask/plan/agent），",
	"\t * 模型选择器在会话登记了模型目录时附加，currentValue 反映当前选择（已切换模型时取",
	"\t * state.modelConfig.modelId）。供 newSession 与 set_config_option 响应共用。",
	"\t */",
	"\tprivate buildSessionConfigOptions(",
	"\t\tstate: IAcpSessionState,",
	"\t): SessionConfigOption[] {",
	"\t\tconst modeOption = buildModeConfigOption(state.mode)",
	"\t\tconst catalog = state.modelCatalog",
	"\t\tif (!catalog) {",
	"\t\t\treturn [modeOption]",
	"\t\t}",
	"\t\tconst currentModelId = state.modelConfig?.modelId ?? catalog.currentModelId",
	"\t\tconst modelCatalog: IAcpModelCatalog =",
	"\t\t\tcurrentModelId !== undefined",
	"\t\t\t\t? { models: catalog.models, currentModelId }",
	"\t\t\t\t: { models: catalog.models }",
	"\t\treturn [modeOption, ...buildModelConfigOptions(modelCatalog)]",
	"\t}",
)
agent = replaceOnce(
	agent,
	"\tasync prompt(params: PromptRequest): Promise<PromptResponse> {",
	t(helpers, "", "\tasync prompt(params: PromptRequest): Promise<PromptResponse> {"),
	"E2: insert helpers before prompt()",
)

// ---------------------------------------------------------------------------
// 4) 写盘前自检（任一不满足即中止，不写任何文件）
// ---------------------------------------------------------------------------
const must = [
	["\tbuildModeConfigOption,", "缺少 mode import"],
	["\ttype IAcpSessionState,", "缺少 IAcpSessionState import"],
	["\ttype SessionConfigOption,", "缺少 SessionConfigOption import"],
	["case MODE_CONFIG_OPTION_ID:", "缺少 mode 路由分支"],
	["private buildSessionConfigOptions(", "缺少 buildSessionConfigOptions 辅助"],
	["private applyModeConfigOption(", "缺少 applyModeConfigOption 辅助"],
]
for (const [needle, msg] of must) {
	if (!agent.includes(needle)) throw new Error("[自检失败] " + msg)
}
if (agent.includes("if (params.configId !== MODEL_CONFIG_OPTION_ID) {"))
	throw new Error("[自检失败] 旧的单分支 configId 判断仍残留")
if (agent.includes("nextCatalog"))
	throw new Error("[自检失败] 旧 nextCatalog 残留")

// ---------------------------------------------------------------------------
// 5) 写盘
// ---------------------------------------------------------------------------
await writeFile(J(MODE_FILE), modeModule, "utf8")
await writeFile(J(MODE_SPEC), modeSpec, "utf8")
await writeFile(J(AGENT), agent, "utf8")

console.log("✅ Slice A1 完成：")
console.log("  + " + MODE_FILE)
console.log("  + " + MODE_SPEC)
console.log("  ~ " + AGENT + "（newSession / setSessionConfigOption + 3 辅助方法）")
console.log("下一步：pnpm --filter builtin-agent typecheck && pnpm --filter builtin-agent test")