import { z } from 'zod';
import { AGENT_RUNTIME_EVENT_SCHEMA_VERSION, AGENT_RUNTIME_EVENT_TYPES, } from '../streaming/stream-types.js';
import { agentPlanRecordSchema, agentPlanSchema, agentPlanStatusSchema } from './plan.js';
// ----------------------------------------------------------------------
// Schema version
// ----------------------------------------------------------------------
/**
 * 顶层 sidecar → UI 协议版本。
 * - bump 时，新增/重命名字段也必须保证 client 能优雅降级。
 * - 不要为 narrow 改动 bump（比如缩窄字面量）。
 */
export const AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION = 2;
export const jsonValueSchema = z.lazy(() => z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
]));
// ----------------------------------------------------------------------
// Sub-schemas
// ----------------------------------------------------------------------
export const approvalRequestSchema = z.object({
    id: z.string().min(1),
    toolName: z.string().min(1),
    question: z.string().min(1),
    summary: z.string().min(1),
    riskLevel: z.enum(['low', 'medium', 'high']),
    reversible: z.boolean(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
});
export const diffHunkSchema = z.object({
    oldStart: z.number().int().nonnegative(),
    oldLines: z.number().int().nonnegative(),
    newStart: z.number().int().nonnegative(),
    newLines: z.number().int().nonnegative(),
    // 每行可选地以 ` `、`+`、`-` 起始（标准 unified diff）；
    // 这里不强制，因为内部生产端可能写不同变种。
    lines: z.array(z.string()),
});
export const diffFileSchema = z.object({
    path: z.string().min(1),
    hunks: z.array(diffHunkSchema),
});
/**
 * 注意：本 schema **保留** `.passthrough()`，所以 `z.infer` 出来的对象
 * 可能携带未列出的字段。下游 narrow 到 `TAgentRuntimeEvent` 时请使用
 * `TAgentUiEventNarrowed`（见文件底部），而不是 `z.infer` 出来的类型。
 */
export const agentRuntimeEventSchema = z.object({
    id: z.string().min(1),
    type: z.enum(AGENT_RUNTIME_EVENT_TYPES),
    runId: z.string().min(1),
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    timestamp: z.string().datetime(),
    seq: z.number().int().nonnegative(),
    schemaVersion: z.literal(AGENT_RUNTIME_EVENT_SCHEMA_VERSION),
    redacted: z.literal(true),
    visibility: z.enum(['user', 'debug']),
    level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
    parentId: z.string().min(1).optional(),
    spanId: z.string().min(1).optional(),
}).passthrough();
/**
 * 语言模型用量。严格模式：未知字段不再隐式 passthrough，
 * 任何未来扩展请走 `raw` 信封。
 */
export const languageModelUsageSchema = z.object({
    inputTokens: z.number().nonnegative(),
    inputTokenDetails: z
        .object({
        noCacheTokens: z.number().nonnegative(),
        cacheReadTokens: z.number().nonnegative(),
        cacheWriteTokens: z.number().nonnegative(),
    })
        .strict()
        .optional(),
    outputTokens: z.number().nonnegative(),
    outputTokenDetails: z
        .object({
        textTokens: z.number().nonnegative(),
        reasoningTokens: z.number().nonnegative(),
    })
        .strict()
        .optional(),
    totalTokens: z.number().nonnegative(),
    // 与 inputTokenDetails.cacheReadTokens 等价 —— 优先用 inputTokenDetails。
    // 兼容旧 caller。
    cachedInputTokens: z.number().nonnegative().optional(),
    reasoningTokens: z.number().nonnegative().optional(),
    raw: z.unknown().optional(),
}).strict();
// ----------------------------------------------------------------------
// UI events
// ----------------------------------------------------------------------
/**
 * 工具事件契约：
 * - `tool_start.input` 和 `tool_result.output` 是 **JSON value** 类型。
 *   生产端必须先把 `Date` / `BigInt` / `undefined` / class 实例等非 JSON 类型
 *   通过 `compactModelOutput`（见 ../models/output-budget.js）
 *   或自定义 serializer 转换后再发出，否则 schema 会拒绝。
 */
export const agentUiEventSchema = z.discriminatedUnion('type', [
    /**
   * 文本增量。
   *
   * **delta 语义（v2+）**：`text` 是相对于已 emit 文本的**增量**，
   * UI 端必须 append 到当前缓冲，**不能**替换。
   *
   * 若需要清空当前缓冲（例如工具调用前），生产端会发 `message_clear`
   * 事件，而**不是** `message_delta` 携带空字符串。
   *
   * `phase`:
   * - `'final'`（或省略）：该增量属于最终回答的一部分。
   * - `'stage'`：该增量是过渡性的（保留以备将来分阶段流式场景）。
   */
    z.object({
        type: z.literal('message_delta'),
        text: z.string(),
        phase: z.enum(['stage', 'final']).optional(),
    }),
    /**
     * 清空当前已显示的消息缓冲。
     *
     * 通常出现在工具调用前 —— 模型在工具调用前可能输出了一段过渡文本，
     * 这部分不应保留在最终答案里。UI 端收到后应清空显示区，
     * 准备接收后续 `message_delta`。
     */
    z.object({
        type: z.literal('message_clear'),
    }),
    z.object({
        type: z.literal('agent_event'),
        event: agentRuntimeEventSchema,
    }),
    z.object({
        type: z.literal('plan_ready'),
        planId: z.string().min(1),
        threadId: z.string().min(1).optional(),
        version: z.number().int().positive(),
        status: agentPlanStatusSchema,
        createdAt: z.string().datetime().optional(),
        updatedAt: z.string().datetime().optional(),
        approvedAt: z.string().datetime().nullable().optional(),
        executedAt: z.string().datetime().nullable().optional(),
        rejectionReason: z.string().min(1).nullable().optional(),
        errorMessage: z.string().min(1).nullable().optional(),
        plan: agentPlanSchema,
    }),
    z.object({
        type: z.literal('plan_record'),
        record: agentPlanRecordSchema,
        versions: z.array(agentPlanRecordSchema),
    }),
    z.object({
        type: z.literal('tool_start'),
        toolName: z.string().min(1),
        input: jsonValueSchema,
    }),
    z.object({
        type: z.literal('tool_result'),
        toolName: z.string().min(1),
        output: jsonValueSchema,
    }),
    z.object({
        type: z.literal('approval_required'),
        request: approvalRequestSchema,
    }),
    z.object({
        type: z.literal('diff_ready'),
        files: z.array(diffFileSchema),
    }),
    z.object({
        type: z.literal('done'),
        result: z.string(),
        usage: languageModelUsageSchema.nullable().optional(),
        /** @deprecated 用 `usage.inputTokens` 代替 */
        promptTokens: z.number().nonnegative().optional(),
        /** @deprecated 用 `usage.outputTokens` 代替 */
        completionTokens: z.number().nonnegative().optional(),
        /** @deprecated 用 `usage.totalTokens` 代替 */
        totalTokens: z.number().nonnegative().optional(),
    }),
    z.object({
        type: z.literal('error'),
        message: z.string().min(1),
        /** 错误分类，便于 client 决定是否重试 / 上报。 */
        code: z.string().min(1).optional(),
        /** 原始 cause 文本，仅诊断用，可能包含敏感信息（已过 redaction）。 */
        cause: z.string().min(1).optional(),
        retryable: z.boolean().optional(),
    }),
]);
// ----------------------------------------------------------------------
// Response envelope
// ----------------------------------------------------------------------
export const agentSidecarResponseSchema = z.object({
    schemaVersion: z.literal(AGENT_SIDECAR_RESPONSE_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    events: z.array(agentUiEventSchema),
    result: z.string().nullable(),
});
