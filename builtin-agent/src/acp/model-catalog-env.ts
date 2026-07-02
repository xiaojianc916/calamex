import type { IAcpModelCatalog, IAcpModelCatalogEntry } from "./model-config-options.js"

const MODEL_IDS_ENV = "CALAMEX_AI_MODEL_IDS"
const CURRENT_MODEL_ID_ENV = "CALAMEX_AI_CURRENT_MODEL_ID"

const providerOf = (modelId: string): string | undefined => {
	const [provider] = modelId.split("/")
	const trimmed = provider?.trim()
	return trimmed ? trimmed.toUpperCase() : undefined
}

/**
 * 自省进程环境变量拼出模型目录（Zed 范式：凭据走 env、宿主启动时注入）。
 * 遍历 CALAMEX_AI_MODEL_IDS，对每个 modelId 取厂商前缀查 CALAMEX_AI_KEY__<PROVIDER>，
 * 有 key 才纳入（即「有哪家 key 就声明哪家模型」）。无任何可用模型时返回 undefined。
 */
export const buildModelCatalogFromEnv = (
	env: NodeJS.ProcessEnv = process.env,
): IAcpModelCatalog | undefined => {
	const raw = env[MODEL_IDS_ENV]?.trim()
	if (!raw) return undefined
	const models: IAcpModelCatalogEntry[] = []
	for (const item of raw.split(",")) {
		const modelId = item.trim()
		if (!modelId) continue
		const provider = providerOf(modelId)
		if (!provider) continue
		const apiKey = env[`CALAMEX_AI_KEY__${provider}`]?.trim()
		if (!apiKey) continue
		const baseUrl = env[`CALAMEX_AI_BASE_URL__${provider}`]?.trim()
		models.push(baseUrl ? { modelId, apiKey, baseUrl } : { modelId, apiKey })
	}
	if (models.length === 0) return undefined
	const currentModelId = env[CURRENT_MODEL_ID_ENV]?.trim()
	return currentModelId ? { models, currentModelId } : { models }
}
