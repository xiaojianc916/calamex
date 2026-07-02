import { describe, expect, it } from "vitest"

import {
	buildModelConfigOptions,
	MODEL_CONFIG_OPTION_ID,
	resolveCurrentModelId,
	resolveModelConfigInput,
} from "./model-config-options.js"

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
