/**
 * builtin agent 会话级「模式选择器」——官方 session config option（category=mode）。
 *
 * ACP 的 session/set_mode 已被官方标注为将在未来版本移除，由 session config options 统一
 * 取代（见 protocol/session-config-options）。本模块据此把用户可选的运行模式（ask / plan /
 * agent）公示为官方 SessionConfigOption（category=mode），经 session/set_config_option
 * (configId="mode") 切换，与模型选择器（category=model）同构，构成唯一的会话配置管线。
 *
 * 纯函数、无状态、无 IO；类型对齐 SDK SessionConfigOption（select 变体）与运行时模式枚举。
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk"

import type { TAgentMode } from "../engines/contracts/runtime-input.js"

/** 模式选择器的 config option id（前端按 id 路由 set_config_option）。 */
export const MODE_CONFIG_OPTION_ID = "mode"

/**
 * 用户可选的运行模式（选择器公示的子集）。
 * patch / review 是内部派生模式（由 agent 执行管线按任务形态自行采用），不进用户选择器。
 * `satisfies` 约束确保这些标识恒为合法的运行时模式（TAgentMode）。
 */
export const USER_SELECTABLE_MODES = [
	"ask",
	"plan",
	"agent",
] as const satisfies readonly TAgentMode[]
export type TUserSelectableMode = (typeof USER_SELECTABLE_MODES)[number]

/** 单个模式的展示文案（name 面向终端用户）。 */
interface IModeDisplay {
	name: string
}

const MODE_DISPLAY: Record<TUserSelectableMode, IModeDisplay> = {
	ask: { name: "询问" },
	plan: { name: "计划" },
	agent: { name: "智能体" },
}

/** value 是否为用户可选模式（运行时仍可能处于 patch/review 等内部模式）。 */
export const isUserSelectableMode = (
	value: string,
): value is TUserSelectableMode =>
	(USER_SELECTABLE_MODES as readonly string[]).includes(value)

/**
 * 把会话当前模式落到选择器的 currentValue：用户可选模式直接采用；
 * 内部派生模式（patch/review）回退到 agent，使选择器恒有合法当前值。
 */
export const resolveCurrentModeValue = (
	mode: TAgentMode,
): TUserSelectableMode => (isUserSelectableMode(mode) ? mode : "agent")

/**
 * 构造会话级模式选择器（单选 select，category=mode）。
 * 形状与模型选择器同构；currentValue 取自会话当前模式，options 为用户可选模式集。
 * 恒非空（ask/plan/agent 三项），故每个会话都会公示该选择器。
 */
export const buildModeConfigOption = (
	mode: TAgentMode,
): SessionConfigOption => ({
	type: "select",
	id: MODE_CONFIG_OPTION_ID,
	name: "模式",
	category: "mode",
	currentValue: resolveCurrentModeValue(mode),
	options: USER_SELECTABLE_MODES.map((value) => ({
		value,
		name: MODE_DISPLAY[value].name,
	})),
})
