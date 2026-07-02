/**
 * builtin agent 会话级「模型选择器」——官方 session config option（ADR-20260617，唯一标准管线）。
 *
 * 背景：builtin 走标准 session/prompt 时，模型配置取自会话状态 state.modelConfig；而其凭据在
 * 宿主侧、launch 有意不向子进程注入模型 env。故宿主在 session/new 经 NewSessionRequest._meta
 * （命名空间键 calamex.dev/modelCatalog）一次性注入「可选模型 + 凭据」目录，本模块据此：
 *   1) newSession 时构造官方模型选择器（SessionConfigOption，category=model）公示给前端；
 *   2) setSessionConfigOption 时把所选 modelId 解析回完整模型配置（含凭据）回写会话。
 * Kimi 等外部 agent 自管凭据、不经此通道（其 config_options 由其自身公示），互不耦合。
 *
 * 纯函数、无状态、无 IO；类型对齐 SDK SessionConfigOption（select 变体）与运行时模型配置输入。
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk"

import type { IAgentRuntimeModelConfigInput } from "../engines/contracts/runtime-input.js"

/** 模型选择器的 config option id（前端按 id 路由 set_config_option）。 */
export const MODEL_CONFIG_OPTION_ID = "model"

/** 单个可选模型及其凭据（宿主从已保存 AI 配置组装，best-effort 仅含有 Key 者）。 */
export interface IAcpModelCatalogEntry {
	modelId: string
	apiKey: string
	baseUrl?: string
}

/** 模型目录：可选模型清单 + 当前选中项（缺省回退首项）。 */
export interface IAcpModelCatalog {
	models: IAcpModelCatalogEntry[]
	currentModelId?: string
}

/** 当前应选中的 modelId：currentModelId 命中则用之，否则回退首项。 */
export const resolveCurrentModelId = (catalog: IAcpModelCatalog): string =>
	catalog.currentModelId ?? catalog.models[0].modelId

/** 把某 modelId 解析为运行时模型配置输入；未命中清单返回 undefined。 */
export const resolveModelConfigInput = (
	catalog: IAcpModelCatalog,
	modelId: string,
): IAgentRuntimeModelConfigInput | undefined => {
	const entry = catalog.models.find((item) => item.modelId === modelId)
	if (entry === undefined) return undefined
	const input: IAgentRuntimeModelConfigInput = {
		modelId: entry.modelId,
		apiKey: entry.apiKey,
	}
	if (entry.baseUrl !== undefined) input.baseUrl = entry.baseUrl
	return input
}

/**
 * 构造会话级模型选择器（单选 select，category=model）。
 * 空目录 => []（不公示选择器，前端选择器恒空、回退环境兜底）。
 * value=modelId、name=modelId（β 期可接显示名）；currentValue 取 resolveCurrentModelId。
 */
export const buildModelConfigOptions = (
	catalog: IAcpModelCatalog | null,
): SessionConfigOption[] => {
	if (catalog === null || catalog.models.length === 0) return []
	return [
		{
			type: "select",
			id: MODEL_CONFIG_OPTION_ID,
			name: "模型",
			category: "model",
			currentValue: resolveCurrentModelId(catalog),
			options: catalog.models.map((entry) => ({
				value: entry.modelId,
				name: entry.modelId,
			})),
		},
	]
}
