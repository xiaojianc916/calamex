// b1b4-b2.mjs
//
// 合并步骤：B1b-4(面板 ACP 计划渲染挂接) + B2(ask_user → 官方 ACP elicitation 反向环)
//
// 前置：必须已应用 b1b-1 / b1b-2 / b1b-3（assistant.acpPlan 已存在于面板 composable）。
// 风格：
//   - builtin-agent/src/acp/*  → 制表符缩进、无分号、双引号（新文件用 2-space 编写后转 tab）。
//   - *.vue                    → 2-space 缩进、有分号、单引号。
// 用法：在本地仓库根目录执行 `node b1b4-b2.mjs`，可单测前可能暂时无法编译（允许）。
//
// 本步为「先建后删」：仅新增/接线，绝不删除旧 ext-method ask_user 路径（D1 阶段再删）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.cwd();

/* ───────────────────────── helpers ───────────────────────── */

function detectEol(text) {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

// 把以 2-space 为单位的前导缩进转换为制表符（JSDoc 的 " * " 单空格保留）。
function spacesToTabs(text) {
	return text
		.split("\n")
		.map((line) => {
			const match = /^( +)/.exec(line);
			if (!match) return line;
			const spaces = match[1].length;
			const tabs = "\t".repeat(Math.floor(spaces / 2));
			const leftover = " ".repeat(spaces % 2);
			return tabs + leftover + line.slice(spaces);
		})
		.join("\n");
}

// 以 [tab缩进数, 文本] 数组构造制表符缩进的代码块。
function blk(lines) {
	return lines
		.map(([indent, text]) => (text ? "\t".repeat(indent) + text : ""))
		.join("\n");
}

function editFile(relPath, edits) {
	const abs = join(ROOT, relPath);
	if (!existsSync(abs)) throw new Error(`目标文件不存在：${relPath}`);
	const original = readFileSync(abs, "utf8");
	const eol = detectEol(original);
	let text = original.split("\r\n").join("\n");
	for (const { oldStr, newStr, label } of edits) {
		const count = text.split(oldStr).length - 1;
		if (count === 0) throw new Error(`[${relPath}] 未找到锚点：${label}`);
		if (count > 1)
			throw new Error(`[${relPath}] 锚点不唯一(命中 ${count} 次)：${label}`);
		text = text.replace(oldStr, () => newStr); // 函数式 replacer，规避 $ 特殊序列
	}
	const out = eol === "\r\n" ? text.split("\n").join("\r\n") : text;
	writeFileSync(abs, out, "utf8");
	console.log(`✓ 已修改 ${relPath}（${edits.length} 处）`);
}

function writeNew(relPath, content) {
	const abs = join(ROOT, relPath);
	if (existsSync(abs))
		throw new Error(`目标文件已存在，拒绝覆盖：${relPath}`);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content.split("\n").join("\n"), "utf8");
	console.log(`✓ 已新建 ${relPath}`);
}

/* ═════════════════ 1) 新建 ask-user-bridge.ts（acp 适配层） ═════════════════ */

const ASK_USER_BRIDGE = `/**
 * ask_user 反向提问 ↔ ACP elicitation 适配层。
 *
 * 与 approval-bridge.ts 同构：把运行时的 \`ask_user_required\` 输出事件投影为 ACP
 * \`elicitation/create\` 表单请求(unstable_createElicitation)，并把客户端回填的
 * CreateElicitationResponse 还原为运行时 resolveAskUser 所需的结构化解决输入。
 *
 * 设计要点：
 * - 每个待回填问题 → requestedSchema.properties 下一个以 questionId 为键的属性：
 *   - 有选项 + 多选 → array(items.anyOf 枚举 {const,title})；
 *   - 有选项 + 单选 → string(oneOf 枚举 {const,title})；yesno 由上游合成是/否选项，归此类；
 *   - 无选项        → string(自由文本)。
 * - message：单问取该问的 question 文案；多问取各问 header 以 " · " 连接。
 * - 回填还原：accept → outcome "selected" + 按问映射 answers；decline/cancel → "cancelled"。
 */
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk"
import { decodeApprovalRequestId } from "../engines/approval/utils.js"
import type { TAgentRuntimeOutputEvent } from "../engines/contracts/runtime-contracts.js"
import type {
  IAskUserAnswerInput,
  TAskUserResolutionOutcome,
} from "../engines/contracts/runtime-input.js"

/** 运行时输出事件中的待回填 ask_user 提问事件(判别联合窄化)。 */
export type TPendingAskUser = Extract<
  TAgentRuntimeOutputEvent,
  { type: "ask_user_required" }
>

/** 单条待回填提问(从事件 request.questions 元素窄化)。 */
type TSurfacedQuestion = TPendingAskUser["request"]["questions"][number]

/** resolveAskUser 所需的最小解决输入(requestId / 会话上下文由调用方补齐)。 */
export interface IAskUserResolution {
  outcome: TAskUserResolutionOutcome
  answers?: IAskUserAnswerInput[]
}

/**
 * 在本次运行的输出事件中反向扫描最近一条待回填 ask_user 提问事件。
 * 与 findPendingApproval 同策略：取最后一条，确保多事件时命中最新挂起点。
 */
export function findPendingAskUser(
  events: readonly TAgentRuntimeOutputEvent[],
): TPendingAskUser | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === "ask_user_required") {
      return event
    }
  }
  return undefined
}

/** 把单条待回填提问映射为一个 ACP elicitation 属性 schema。 */
function toPropertySchema(
  question: TSurfacedQuestion,
): ElicitationPropertySchema {
  const options = question.options ?? []
  if (options.length === 0) {
    return {
      type: "string",
      title: question.header,
      description: question.question,
    }
  }
  if (question.multiSelect === true) {
    return {
      type: "array",
      title: question.header,
      description: question.question,
      items: {
        anyOf: options.map((option) => ({
          const: option.optionId,
          title: option.label,
        })),
      },
    }
  }
  return {
    type: "string",
    title: question.header,
    description: question.question,
    oneOf: options.map((option) => ({
      const: option.optionId,
      title: option.label,
    })),
  }
}

/**
 * 把一条待回填 ask_user 提问事件投影为 ACP elicitation/create 表单请求。
 * requestId 形如 encodeApprovalRequestId(runId, toolCallId)，解码可得 toolCallId 关联工具调用。
 */
export function toCreateElicitationRequest(
  sessionId: string,
  pending: TPendingAskUser,
): CreateElicitationRequest {
  const questions = pending.request.questions
  const properties: Record<string, ElicitationPropertySchema> = {}
  for (const question of questions) {
    properties[question.questionId] = toPropertySchema(question)
  }
  const message =
    questions.length === 1
      ? questions[0].question
      : questions.map((question) => question.header).join(" · ")
  const decoded = decodeApprovalRequestId(pending.requestId)
  return {
    mode: "form",
    sessionId,
    ...(decoded?.toolCallId ? { toolCallId: decoded.toolCallId } : {}),
    requestedSchema: {
      type: "object",
      properties,
    },
    message,
  }
}

/** 把单条提问的回填值还原为运行时结构化答案。 */
function toAnswer(
  question: TSurfacedQuestion,
  value: ElicitationContentValue | undefined,
): IAskUserAnswerInput {
  const options = question.options ?? []
  if (options.length === 0) {
    return {
      questionId: question.questionId,
      optionIds: [],
      ...(typeof value === "string" ? { text: value } : {}),
    }
  }
  if (question.multiSelect === true) {
    return {
      questionId: question.questionId,
      optionIds: Array.isArray(value) ? value : [],
    }
  }
  return {
    questionId: question.questionId,
    optionIds: typeof value === "string" ? [value] : [],
  }
}

/**
 * 把客户端 elicitation 回填响应还原为 resolveAskUser 解决输入。
 * accept → "selected" + 按原提问顺序映射 answers；decline/cancel → "cancelled"(不携 answers)。
 */
export function toAskUserResolutionInput(
  response: CreateElicitationResponse,
  pending: TPendingAskUser,
): IAskUserResolution {
  if (response.action !== "accept") {
    return { outcome: "cancelled" }
  }
  const content: Record<string, ElicitationContentValue> = response.content ?? {}
  const answers = pending.request.questions.map((question) =>
    toAnswer(question, content[question.questionId]),
  )
  return { outcome: "selected", answers }
}
`;

/* ═════════════════ 2) 新建 ask-user-bridge.spec.ts ═════════════════ */

const ASK_USER_BRIDGE_SPEC = `import { describe, expect, it } from "vitest"

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
`;

/* ═════════════════ 3) 接线 acp/agent.ts（4 处，制表符锚点） ═════════════════ */

const AGENT = "builtin-agent/src/acp/agent.ts";

editFile(AGENT, [
	{
		label: "SDK import：插入 CreateElicitation 请求/响应类型",
		oldStr: blk([
			[1, "type CancelNotification,"],
			[1, "type InitializeRequest,"],
		]),
		newStr: blk([
			[1, "type CancelNotification,"],
			[1, "type CreateElicitationRequest,"],
			[1, "type CreateElicitationResponse,"],
			[1, "type InitializeRequest,"],
		]),
	},
	{
		label: "在 approval-bridge import 后追加 ask-user-bridge import",
		oldStr: `} from "./approval-bridge.js"`,
		newStr: blk([
			[0, `} from "./approval-bridge.js"`],
			[0, "import {"],
			[1, "findPendingAskUser,"],
			[1, "toAskUserResolutionInput,"],
			[1, "toCreateElicitationRequest,"],
			[0, `} from "./ask-user-bridge.js"`],
		]),
	},
	{
		label: "IAcpAgentConnection：新增 unstable_createElicitation",
		oldStr: blk([
			[1, "requestPermission("],
			[2, "params: RequestPermissionRequest,"],
			[1, "): Promise<RequestPermissionResponse>"],
			[0, "}"],
		]),
		newStr: blk([
			[1, "requestPermission("],
			[2, "params: RequestPermissionRequest,"],
			[1, "): Promise<RequestPermissionResponse>"],
			[1, "/**"],
			[1, " * 在回合内发起反向 elicitation/create 表单请求，向用户征集 ask_user 提问的回填。"],
			[1, " * SDK 的 AgentSideConnection.unstable_createElicitation 结构上满足本签名。"],
			[1, " */"],
			[1, "unstable_createElicitation("],
			[2, "params: CreateElicitationRequest,"],
			[1, "): Promise<CreateElicitationResponse>"],
			[0, "}"],
		]),
	},
	{
		label: "prompt() 回合编排环：增设 ask_user 反向 elicitation 分支",
		oldStr: blk([
			[4, "const pending = findPendingApproval(response.events)"],
			[4, "if (!pending) {"],
			[5, "break"],
			[4, "}"],
			[4, "const permission = await this.connection.requestPermission("],
			[5, "toRequestPermissionRequest(params.sessionId, pending),"],
			[4, ")"],
			[4, "if (controller.signal.aborted) {"],
			[5, `return promptResponse("cancelled")`],
			[4, "}"],
			[4, "const decision = toApprovalDecision(permission)"],
			[4, `if (decision === "cancel") {`],
			[5, "// 客户端在权限请求挂起期间取消了本回合：以 cancelled 收场；"],
			[5, "// 引擎侧挂起的运行由其 TTL 驱逐自动回收。"],
			[5, `return promptResponse("cancelled")`],
			[4, "}"],
			[4, "response = await this.runtime.resolveApproval("],
			[5, "{"],
			[6, "requestId: pending.id,"],
			[6, "decision,"],
			[6, "sessionId: params.sessionId,"],
			[6, "workspaceRootPath: state.workspaceRootPath,"],
			[6, "...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),"],
			[5, "},"],
			[5, "runOptions(),"],
			[4, ")"],
		]),
		newStr: blk([
			[4, "// 审批门：本次运行以待裁决审批收尾 → 反向 session/request_permission 取裁决回灌续跑。"],
			[4, "const pendingApproval = findPendingApproval(response.events)"],
			[4, "if (pendingApproval) {"],
			[5, "const permission = await this.connection.requestPermission("],
			[6, "toRequestPermissionRequest(params.sessionId, pendingApproval),"],
			[5, ")"],
			[5, "if (controller.signal.aborted) {"],
			[6, `return promptResponse("cancelled")`],
			[5, "}"],
			[5, "const decision = toApprovalDecision(permission)"],
			[5, `if (decision === "cancel") {`],
			[6, "// 客户端在权限请求挂起期间取消了本回合：以 cancelled 收场；"],
			[6, "// 引擎侧挂起的运行由其 TTL 驱逐自动回收。"],
			[6, `return promptResponse("cancelled")`],
			[5, "}"],
			[5, "response = await this.runtime.resolveApproval("],
			[6, "{"],
			[7, "requestId: pendingApproval.id,"],
			[7, "decision,"],
			[7, "sessionId: params.sessionId,"],
			[7, "workspaceRootPath: state.workspaceRootPath,"],
			[7, "...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),"],
			[6, "},"],
			[6, "runOptions(),"],
			[5, ")"],
			[5, "continue"],
			[4, "}"],
			[4, "// ask_user 反向提问门：本次运行以待回填提问收尾 → 反向 elicitation/create 取用户回填回灌续跑。"],
			[4, "const pendingAskUser = findPendingAskUser(response.events)"],
			[4, "if (pendingAskUser) {"],
			[5, "if (!this.runtime.resolveAskUser) {"],
			[6, "throw new Error("],
			[7, `"运行时不支持 ask_user 反向提问恢复(缺少 resolveAskUser)。",`],
			[6, ")"],
			[5, "}"],
			[5, "const elicitation = await this.connection.unstable_createElicitation("],
			[6, "toCreateElicitationRequest(params.sessionId, pendingAskUser),"],
			[5, ")"],
			[5, "if (controller.signal.aborted) {"],
			[6, `return promptResponse("cancelled")`],
			[5, "}"],
			[5, "const resolution = toAskUserResolutionInput(elicitation, pendingAskUser)"],
			[5, "response = await this.runtime.resolveAskUser("],
			[6, "{"],
			[7, "requestId: pendingAskUser.requestId,"],
			[7, "outcome: resolution.outcome,"],
			[7, "...(resolution.answers ? { answers: resolution.answers } : {}),"],
			[7, "sessionId: params.sessionId,"],
			[7, "workspaceRootPath: state.workspaceRootPath,"],
			[7, "...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),"],
			[6, "},"],
			[6, "runOptions(),"],
			[5, ")"],
			[5, "continue"],
			[4, "}"],
			[4, "// 无待裁决审批、无待回填提问 → 回合自然收尾。"],
			[4, "break"],
		]),
	},
]);

/* ═════════════════ 4) 面板渲染挂接 B1b-4（2-space / 分号 / 单引号） ═════════════════ */

const PANEL = "src/components/business/ai/shell/AiAssistantPanel.vue";

editFile(PANEL, [
	{
		label: "planSteps：ACP 计划优先，旧 store 过渡兜底",
		oldStr:
			"const planSteps = computed<IAiTaskPlanStep[]>(() => planStore.value.steps);",
		newStr: [
			"// ACP 计划就绪时以 session/update plan 投影为唯一来源；否则回退旧 store(过渡期)。",
			"const planSteps = computed<IAiTaskPlanStep[]>(() =>",
			"  assistant.acpPlan.hasPlan.value ? assistant.acpPlan.steps.value : planStore.value.steps,",
			");",
		].join("\n"),
	},
]);

/* ═════════════════ 5) 写入新文件 ═════════════════ */

writeNew("builtin-agent/src/acp/ask-user-bridge.ts", spacesToTabs(ASK_USER_BRIDGE));
writeNew(
	"builtin-agent/src/acp/ask-user-bridge.spec.ts",
	spacesToTabs(ASK_USER_BRIDGE_SPEC),
);

/* ═════════════════ 6) 收尾自检 ═════════════════ */

console.log("");
console.log("──────────────────────────────────────────────");
console.log("✓ B1b-4 + B2 接线完成（先建后删，未删任何旧路径）。");
console.log("  · acp/agent.ts        : 4 处接线（import×2 / 连接面 / prompt 环）");
console.log("  · acp/ask-user-bridge : 新建桥接 + 单测");
console.log("  · AiAssistantPanel.vue: planSteps 以 ACP 计划为先");
console.log("  说明：output-event-stream.ts 的 ask_user_required → [] 保持不变");
console.log("        （反向 RPC 带外处理，与 approval 同构，无需改动）。");
console.log("  下一步：B3(组合式纯 session/prompt 化) → B4(Tauri sidecar_prompt) → D1(删旧三件套)。");
console.log("──────────────────────────────────────────────");