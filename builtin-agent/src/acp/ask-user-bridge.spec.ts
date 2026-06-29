import { describe, expect, it } from "vitest"

import { encodeApprovalRequestId } from "../engines/approval/utils.js"
import type { TAgentRuntimeOutputEvent } from "../engines/contracts/runtime-contracts.js"
import {
	findPendingAskUser,
	toAskUserResolutionInput,
	toCreateElicitationRequest,
	type TPendingAskUser,
} from "./ask-user-bridge.js"
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk"

function pendingAskUser(
	questions: TPendingAskUser["request"]["questions"],
	requestId = encodeApprovalRequestId("run-1", "tool-1"),
): TPendingAskUser {
	return {
		type: "ask_user_required",
		requestId,
		request: { kind: "user_question", questions },
	} as TPendingAskUser
}

function formSchema(request: CreateElicitationRequest) {
	if (request.mode !== "form") {
		throw new Error("expected form elicitation request")
	}
	return request.requestedSchema
}

describe("findPendingAskUser", () => {
	it("反向扫描返回最近一条 ask_user_required 事件", () => {
		const first = pendingAskUser(
			[{ questionId: "q1", question: "甲?", header: "甲", type: "text" }],
			encodeApprovalRequestId("run-1", "tool-1"),
		)
		const second = pendingAskUser(
			[{ questionId: "q1", question: "乙?", header: "乙", type: "text" }],
			encodeApprovalRequestId("run-1", "tool-2"),
		)
		const events: TAgentRuntimeOutputEvent[] = [
			first,
			{ type: "agent_event" } as TAgentRuntimeOutputEvent,
			second,
		]
		expect(findPendingAskUser(events)).toBe(second)
	})

	it("无 ask_user_required 时返回 undefined", () => {
		expect(
			findPendingAskUser([{ type: "agent_event" } as TAgentRuntimeOutputEvent]),
		).toBeUndefined()
	})
})

describe("toCreateElicitationRequest", () => {
	it("单选提问映射为 string + oneOf，并解出 toolCallId 与单问 message", () => {
		const pending = pendingAskUser([
			{
				questionId: "q1",
				question: "选择部署环境?",
				header: "环境",
				type: "choice",
				options: [
					{ optionId: "q1-o1", label: "预发" },
					{ optionId: "q1-o2", label: "生产" },
				],
			},
		])
		expect(toCreateElicitationRequest("session-1", pending)).toEqual({
			mode: "form",
			sessionId: "session-1",
			toolCallId: "tool-1",
			requestedSchema: {
				type: "object",
				properties: {
					q1: {
						type: "string",
						title: "环境",
						description: "选择部署环境?",
						oneOf: [
							{ const: "q1-o1", title: "预发" },
							{ const: "q1-o2", title: "生产" },
						],
					},
				},
			},
			message: "选择部署环境?",
		})
	})

	it("多选提问映射为 array + items.anyOf", () => {
		const pending = pendingAskUser([
			{
				questionId: "q1",
				question: "选择要包含的模块?",
				header: "模块",
				type: "choice",
				multiSelect: true,
				options: [
					{ optionId: "q1-o1", label: "前端" },
					{ optionId: "q1-o2", label: "后端" },
				],
			},
		])
		const request = toCreateElicitationRequest("session-1", pending)
		expect(formSchema(request).properties?.q1).toEqual({
			type: "array",
			title: "模块",
			description: "选择要包含的模块?",
			items: {
				anyOf: [
					{ const: "q1-o1", title: "前端" },
					{ const: "q1-o2", title: "后端" },
				],
			},
		})
	})

	it("无选项映射为自由文本 string；多问 message 以 header 连接", () => {
		const pending = pendingAskUser([
			{ questionId: "q1", question: "项目名?", header: "名称", type: "text" },
			{
				questionId: "q2",
				question: "是否启用遥测?",
				header: "遥测",
				type: "yesno",
				options: [
					{ optionId: "yes", label: "是" },
					{ optionId: "no", label: "否" },
				],
			},
		])
		const request = toCreateElicitationRequest("session-1", pending)
		expect(formSchema(request).properties?.q1).toEqual({
			type: "string",
			title: "名称",
			description: "项目名?",
		})
		expect(formSchema(request).properties?.q2).toEqual({
			type: "string",
			title: "遥测",
			description: "是否启用遥测?",
			oneOf: [
				{ const: "yes", title: "是" },
				{ const: "no", title: "否" },
			],
		})
		expect(request.message).toBe("名称 · 遥测")
	})
})

describe("toAskUserResolutionInput", () => {
	it("accept 单选 → selected + optionIds 单元素", () => {
		const pending = pendingAskUser([
			{
				questionId: "q1",
				question: "环境?",
				header: "环境",
				type: "choice",
				options: [
					{ optionId: "q1-o1", label: "预发" },
					{ optionId: "q1-o2", label: "生产" },
				],
			},
		])
		expect(
			toAskUserResolutionInput(
				{ action: "accept", content: { q1: "q1-o2" } },
				pending,
			),
		).toEqual({
			outcome: "selected",
			answers: [{ questionId: "q1", optionIds: ["q1-o2"] }],
		})
	})

	it("accept 多选 → optionIds 多元素", () => {
		const pending = pendingAskUser([
			{
				questionId: "q1",
				question: "模块?",
				header: "模块",
				type: "choice",
				multiSelect: true,
				options: [
					{ optionId: "q1-o1", label: "前端" },
					{ optionId: "q1-o2", label: "后端" },
				],
			},
		])
		expect(
			toAskUserResolutionInput(
				{ action: "accept", content: { q1: ["q1-o1", "q1-o2"] } },
				pending,
			),
		).toEqual({
			outcome: "selected",
			answers: [{ questionId: "q1", optionIds: ["q1-o1", "q1-o2"] }],
		})
	})

	it("accept 文本 → text + 空 optionIds", () => {
		const pending = pendingAskUser([
			{ questionId: "q1", question: "名称?", header: "名称", type: "text" },
		])
		expect(
			toAskUserResolutionInput(
				{ action: "accept", content: { q1: "calamex" } },
				pending,
			),
		).toEqual({
			outcome: "selected",
			answers: [{ questionId: "q1", optionIds: [], text: "calamex" }],
		})
	})

	it("decline → cancelled(不携 answers)", () => {
		const pending = pendingAskUser([
			{ questionId: "q1", question: "名称?", header: "名称", type: "text" },
		])
		expect(toAskUserResolutionInput({ action: "decline" }, pending)).toEqual({
			outcome: "cancelled",
		})
	})

	it("cancel → cancelled", () => {
		const pending = pendingAskUser([
			{ questionId: "q1", question: "名称?", header: "名称", type: "text" },
		])
		expect(toAskUserResolutionInput({ action: "cancel" }, pending)).toEqual({
			outcome: "cancelled",
		})
	})
})
