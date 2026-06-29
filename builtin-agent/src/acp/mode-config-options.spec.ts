import { describe, expect, it } from "vitest"

import {
	buildModeConfigOption,
	isUserSelectableMode,
	MODE_CONFIG_OPTION_ID,
	resolveCurrentModeValue,
	USER_SELECTABLE_MODES,
} from "./mode-config-options.js"

describe("isUserSelectableMode", () => {
	it("仅 ask/plan/agent 为用户可选模式", () => {
		expect(isUserSelectableMode("ask")).toBe(true)
		expect(isUserSelectableMode("plan")).toBe(true)
		expect(isUserSelectableMode("agent")).toBe(true)
		expect(isUserSelectableMode("patch")).toBe(false)
		expect(isUserSelectableMode("review")).toBe(false)
		expect(isUserSelectableMode("bogus")).toBe(false)
	})
})

describe("resolveCurrentModeValue", () => {
	it("用户可选模式原样返回", () => {
		expect(resolveCurrentModeValue("ask")).toBe("ask")
		expect(resolveCurrentModeValue("plan")).toBe("plan")
		expect(resolveCurrentModeValue("agent")).toBe("agent")
	})
	it("内部派生模式回退 agent", () => {
		expect(resolveCurrentModeValue("patch")).toBe("agent")
		expect(resolveCurrentModeValue("review")).toBe("agent")
	})
})

describe("buildModeConfigOption", () => {
	it("构造 category=mode 的单选选择器并带当前值与全部可选模式", () => {
		expect(buildModeConfigOption("plan")).toMatchObject({
			type: "select",
			id: MODE_CONFIG_OPTION_ID,
			category: "mode",
			currentValue: "plan",
			options: [{ value: "ask" }, { value: "plan" }, { value: "agent" }],
		})
		expect(USER_SELECTABLE_MODES).toEqual(["ask", "plan", "agent"])
	})
	it("内部派生模式作为当前值时回退 agent", () => {
		expect(buildModeConfigOption("review")).toMatchObject({
			currentValue: "agent",
		})
	})
})
