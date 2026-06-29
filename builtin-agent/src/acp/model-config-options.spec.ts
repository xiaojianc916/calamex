import { describe, expect, it } from "vitest"

import {
	buildModelConfigOptions,
	MODEL_CATALOG_META_KEY,
	MODEL_CONFIG_OPTION_ID,
	parseModelCatalogFromMeta,
	resolveCurrentModelId,
	resolveModelConfigInput,
} from "./model-config-options.js"

const meta = (catalog: unknown): Record<string, unknown> => ({
	[MODEL_CATALOG_META_KEY]: catalog,
})

describe("parseModelCatalogFromMeta", () => {
	it("解析有效条目并按 modelId 保序去重", () => {
		const result = parseModelCatalogFromMeta(
			meta({
				models: [
					{ modelId: "deepseek/deepseek-v4-pro", apiKey: "k1", baseUrl: "https://x" },
					{ modelId: "zhipuai/glm-4.7-flash", apiKey: "k2" },
					{ modelId: "deepseek/deepseek-v4-pro", apiKey: "dup" },
				],
				currentModelId: "zhipuai/glm-4.7-flash",
			}),
		)
		expect(result?.models.map((m) => m.modelId)).toEqual([
			"deepseek/deepseek-v4-pro",
			"zhipuai/glm-4.7-flash",
		])
		expect(result?.currentModelId).toBe("zhipuai/glm-4.7-flash")
	})

	it("丢弃缺 modelId / apiKey 的条目", () => {
		const result = parseModelCatalogFromMeta(
			meta({ models: [{ modelId: "a/b" }, { apiKey: "k" }, { modelId: "c/d", apiKey: "k" }] }),
		)
		expect(result?.models.map((m) => m.modelId)).toEqual(["c/d"])
	})

	it("缺失 / 非法 / 空清单 => null", () => {
		expect(parseModelCatalogFromMeta(null)).toBeNull()
		expect(parseModelCatalogFromMeta(undefined)).toBeNull()
		expect(parseModelCatalogFromMeta({})).toBeNull()
		expect(parseModelCatalogFromMeta(meta({ models: [] }))).toBeNull()
		expect(parseModelCatalogFromMeta(meta({ models: "nope" }))).toBeNull()
	})

	it("currentModelId 不在清单中则忽略", () => {
		const result = parseModelCatalogFromMeta(
			meta({ models: [{ modelId: "a/b", apiKey: "k" }], currentModelId: "x/y" }),
		)
		expect(result?.currentModelId).toBeUndefined()
	})
})

describe("resolveCurrentModelId", () => {
	it("优先 currentModelId，否则回退首项", () => {
		expect(
			resolveCurrentModelId({ models: [{ modelId: "a/b", apiKey: "k" }], currentModelId: "a/b" }),
		).toBe("a/b")
		expect(
			resolveCurrentModelId({
				models: [{ modelId: "a/b", apiKey: "k" }, { modelId: "c/d", apiKey: "k" }],
			}),
		).toBe("a/b")
	})
})

describe("resolveModelConfigInput", () => {
	it("命中返回完整凭据，否则 undefined", () => {
		const catalog = { models: [{ modelId: "a/b", apiKey: "k", baseUrl: "https://x" }] }
		expect(resolveModelConfigInput(catalog, "a/b")).toEqual({
			modelId: "a/b",
			apiKey: "k",
			baseUrl: "https://x",
		})
		expect(resolveModelConfigInput(catalog, "z/z")).toBeUndefined()
	})
})

describe("buildModelConfigOptions", () => {
	it("空目录 => []", () => {
		expect(buildModelConfigOptions(null)).toEqual([])
		expect(buildModelConfigOptions({ models: [] })).toEqual([])
	})

	it("构造单个模型选择器并带当前值", () => {
		const options = buildModelConfigOptions({
			models: [{ modelId: "a/b", apiKey: "k" }, { modelId: "c/d", apiKey: "k" }],
			currentModelId: "c/d",
		})
		expect(options).toHaveLength(1)
		expect(options[0]).toMatchObject({
			type: "select",
			id: MODEL_CONFIG_OPTION_ID,
			category: "model",
			currentValue: "c/d",
			options: [{ value: "a/b" }, { value: "c/d" }],
		})
	})
})
