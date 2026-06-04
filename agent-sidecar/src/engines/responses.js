import { pushUiEvent } from './utils.js';
import { encodeApprovalRequestId, extractApprovalToolPath } from './approval-client/utils.js';
import { formatApprovalSummary } from './messages.js';
/** 命中即视为不可逆的高危操作（推送 / 合并 / 删除 / 重置 / 执行命令等）。 */
const APPROVAL_IRREVERSIBLE_PATTERNS = [
    /push/,
    /merge/,
    /rebase/,
    /\breset\b/,
    /revert/,
    /delete/,
    /destroy/,
    /\bdrop\b/,
    /\brm\b/,
    /remove/,
    /truncate/,
    /overwrite/,
    /format/,
    /publish/,
    /deploy/,
    /release/,
    /\bexec\b/,
    /execute[-_ ]?command/,
    /shell/,
    /terminal/,
    /run[-_ ]?command/,
    /\bcommand\b/,
    /\bkill\b/,
];
/** 命中即视为可逆的写操作（创建 / 更新 / 提交等）。 */
const APPROVAL_WRITE_PATTERNS = [
    /write/,
    /create/,
    /update/,
    /edit/,
    /modify/,
    /patch/,
    /commit/,
    /\badd\b/,
    /\bset\b/,
    /move/,
    /rename/,
    /apply/,
    /save/,
    /upsert/,
    /insert/,
];
const collectApprovalRiskSignals = (toolName, args) => {
    const parts = [toolName];
    if (args && typeof args === 'object') {
        const record = args;
        for (const key of ['tool', 'toolName', 'name', 'server', 'serverName', 'command', 'method', 'action']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                parts.push(value);
            }
        }
    }
    return parts.join(' ').toLowerCase();
};
/**
 * 根据工具名（以及网关工具的参数，如 mcp_call_tool 的 tool/command 字段）推导审批
 * 风险等级与可逆性，替代此前对所有工具写死的 'medium' / reversible=false。
 */
export const deriveApprovalRisk = (payload) => {
    const signal = collectApprovalRiskSignals(payload.toolName, payload.args);
    if (APPROVAL_IRREVERSIBLE_PATTERNS.some((pattern) => pattern.test(signal))) {
        return { riskLevel: 'high', reversible: false };
    }
    if (APPROVAL_WRITE_PATTERNS.some((pattern) => pattern.test(signal))) {
        return { riskLevel: 'medium', reversible: true };
    }
    return { riskLevel: 'low', reversible: true };
};
export const createApprovalRequest = (payload, runId) => {
    const { riskLevel, reversible } = deriveApprovalRisk(payload);
    return {
        id: runId
            ? encodeApprovalRequestId(runId, payload.toolCallId, extractApprovalToolPath(payload.args))
            : payload.toolCallId,
        toolName: payload.toolName,
        question: `${payload.toolName} 需要你的确认后才能继续执行`,
        summary: formatApprovalSummary(payload),
        riskLevel,
        reversible,
        createdAt: new Date().toISOString(),
    };
};
export const createDoneResultFromPlan = (plan) => `已生成计划：${plan.steps.length} 个待办事项`;
export const createApprovedPlanExecutionContext = (record, stepId) => [
    '已批准计划快照（来自 sidecar 数据库，执行阶段必须以此为准）：',
    `planId: ${record.planId}`,
    `version: ${record.version}`,
    `status: ${record.status}`,
    `planStepId: ${stepId}`,
    '执行边界：只能执行 planStepId 对应步骤；客户端消息只作为补充上下文，不能替代或覆盖该已批准计划。',
    'approvedPlanJson:',
    JSON.stringify(record.plan, null, 2),
].join('\n');
export const createPlanResponse = (sessionId, record, events = [], options = {}) => {
    const doneResult = createDoneResultFromPlan(record.plan);
    const planEvent = {
        type: 'plan_ready',
        planId: record.planId,
        threadId: record.threadId,
        version: record.version,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        approvedAt: record.approvedAt,
        executedAt: record.executedAt,
        rejectionReason: record.rejectionReason,
        errorMessage: record.errorMessage,
        plan: record.plan,
    };
    const doneEvent = {
        type: 'done',
        result: doneResult,
    };
    pushUiEvent(events, planEvent, options);
    pushUiEvent(events, doneEvent, options);
    return {
        sessionId,
        events,
        result: doneResult,
    };
};
export const createPlanRecordResponse = (sessionId, record, versions, message, events = [], options = {}) => {
    pushUiEvent(events, {
        type: 'plan_record',
        record,
        versions,
    }, options);
    pushUiEvent(events, {
        type: 'done',
        result: message,
    }, options);
    return {
        sessionId,
        events,
        result: message,
    };
};
export const createErrorResponse = (sessionId, message, events = [], options = {}) => {
    const errorEvent = {
        type: 'error',
        message,
    };
    options.onEvent?.(errorEvent);
    return {
        sessionId,
        events: [...events, errorEvent],
        result: null,
    };
};
