import { describe, expect, it } from "vitest"

import { buildModelCatalogFromEnv } from "./model-catalog-env.js"

describe("buildModelCatalogFromEnv", () => {
	it("无 CALAMEX_AI_MODEL_IDS 时返回 undefined", () => {
		expect(buildModelCatalogFromEnv({})).toBeUndefined()
	})

	it("仅纳入有对应厂商 key 的模型", () => {
		const catalog = buildModelCatalogFromEnv({
			CALAMEX_AI_MODEL_IDS: "deepseek/deepseek-v4-pro,zhipuai/glm-4.7-flash",
			CALAMEX_AI_KEY__DEEPSEEK: "sk-deepseek",
			// 故意不给 zhipuai key → 应被过滤掉
			CALAMEX_AI_CURRENT_MODEL_ID: "deepseek/deepseek-v4-pro",
		})
		expect(catalog).toEqual({
			models: [{ modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-deepseek" }],
			currentModelId: "deepseek/deepseek-v4-pro",
		})
	})

	it("同厂商多模型共享一把 key，且带上 base_url", () => {
		const catalog = buildModelCatalogFromEnv({
			CALAMEX_AI_MODEL_IDS: "deepseek/deepseek-v4-pro,deepseek/deepseek-r2",
			CALAMEX_AI_KEY__DEEPSEEK: "sk-deepseek",
			CALAMEX_AI_BASE_URL__DEEPSEEK: "https://api.deepseek.com/v1",
		})
		expect(catalog).toEqual({
			models: [
				{ modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1" },
				{ modelId: "deepseek/deepseek-r2", apiKey: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1" },
			],
		})
	})

	it("清单里所有模型都无 key 时返回 undefined", () => {
		expect(
			buildModelCatalogFromEnv({ CALAMEX_AI_MODEL_IDS: "deepseek/x,zhipuai/y" }),
		).toBeUndefined()
	})

	it("忽略缺厂商前缀 / 空白项", () => {
		const catalog = buildModelCatalogFromEnv({
			CALAMEX_AI_MODEL_IDS: " , no-prefix , deepseek/deepseek-v4-pro ",
			CALAMEX_AI_KEY__DEEPSEEK: "sk-deepseek",
		})
		expect(catalog).toEqual({
			models: [{ modelId: "deepseek/deepseek-v4-pro", apiKey: "sk-deepseek" }],
		})
	})
})
