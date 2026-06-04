import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeToolExecutionContext } from './test-support/tool-context.js';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { decodeApprovalRequestId } from './engines/approval-client/utils.js';
import { createMastraMemoryScope, mastraWorkingMemorySchema, resolveMastraStorageDirectory, resolveMastraStorageUrl, resolveMemoryLastMessages, resolveObservationalMemoryBufferingEnabled, resolveObservationalMemoryEnabled, resolveProjectUuid, resolveSemanticRecallEnabled, } from './engines/context/memory.js';
import { MastraRuntime, } from './engines/mastra-runtime.js';
import { LibsqlAgentPlanStore, } from './engines/plan/plan-store.js';
import { LibsqlAgentPlanWorkflowStore } from './engines/plan/plan-workflow-store.js';
import { buildSystemPrompt, extractVisibleAgentResultText } from './engines/prompts/system-prompt.js';
import { createConfiguredRuntime, resolveConfiguredRuntimeName, } from './engines/runtime.js';
import { allowWorkspaceWriteAfterVerifiedRead } from './engines/workspace.js';
import { createMastraObserverModelConfig, createMastraReflectorModelConfig, } from './models/config.js';
import { compactModelOutput } from './models/output-budget.js';
import { createDeepSeekMastraGateway, } from './models/providers/deepseek-mastra-gateway.js';
import { clearDeepSeekReasoningStoreForTest, deepseekReasoningFetch, runWithDeepSeekReasoningContext, } from './models/providers/deepseek-reasoning-fetch.js';
import { agentPlanDeltaSchema, agentPlanValidationReportSchema, } from './schemas/plan-workflow.js';
import { agentPlanGenerationSchema, agentPlanSchema } from './schemas/plan.js';
import { agentSidecarChatRequestSchema, agentSidecarExecuteRequestSchema, agentSidecarPlanRequestSchema, agentSidecarRollbackRestoreRequestSchema, createAgentSidecarServer, } from './server.js';
import { ensureMastraLogFile } from './tools/log.js';
import { createMastraTimeTools } from './tools/time.js';
const unsupportedRuntimeResponse = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedApprovalResolution = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const isMastraRequestContextLike = (value) => Boolean(value
    && typeof value === 'object'
    && 'get' in value
    && typeof value.get === 'function'
    && 'toJSON' in value
    && typeof value.toJSON === 'function');
const isZodLikeSchema = (value) => Boolean(value
    && typeof value === 'object'
    && 'safeParse' in value
    && typeof value.safeParse === 'function');
const assertSchemaAccepts = (schema, input) => {
    assert.equal(isZodLikeSchema(schema), true);
    if (!isZodLikeSchema(schema)) {
        throw new Error('schema does not support safeParse');
    }
    assert.equal(schema.safeParse(input).success, true);
};
const assertMastraRequestContext = (value, expected) => {
    assert.equal(isMastraRequestContextLike(value), true);
    if (!isMastraRequestContextLike(value)) {
        return;
    }
    for (const [key, expectedValue] of Object.entries(expected)) {
        assert.deepEqual(value.get(key), expectedValue);
    }
    assert.deepEqual(value.toJSON(), expected);
};
const unsupportedRollbackRestore = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedPlanApproval = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedPlanQuery = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedPlanReject = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedPlanFinish = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedPlanValidation = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const unsupportedPlanReplan = async (...args) => {
    void args;
    throw new Error('Not implemented in test runtime.');
};
const createTestModelConfig = (overrides = {}) => ({
    modelId: 'deepseek/deepseek-chat',
    providerId: 'deepseek',
    providerModelId: 'deepseek-chat',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    customGateways: [
        createDeepSeekMastraGateway({
            apiKey: 'test-key',
            baseUrl: 'https://example.com/v1',
        }),
    ],
    model: new ModelRouterLanguageModel({
        providerId: 'deepseek',
        modelId: 'deepseek-chat',
        apiKey: 'test-key',
        url: 'https://example.com/v1',
    }),
    ...overrides,
});
const createFakeRuntime = (overrides = {}) => ({
    name: 'mastra',
    version: 'test-version',
    chat: unsupportedRuntimeResponse,
    plan: unsupportedRuntimeResponse,
    execute: unsupportedRuntimeResponse,
    approvePlan: unsupportedPlanApproval,
    getPlan: unsupportedPlanQuery,
    rejectPlan: unsupportedPlanReject,
    finishPlan: unsupportedPlanFinish,
    validatePlan: unsupportedPlanValidation,
    replanPlan: unsupportedPlanReplan,
    resolveApproval: unsupportedApprovalResolution,
    restoreCheckpoint: unsupportedRollbackRestore,
    ...overrides,
});
const createPlanRecordForTest = (overrides = {}) => {
    const plan = agentPlanSchema.parse({
        goal: '请直接执行',
        summary: '执行已批准步骤。',
        requiresApproval: true,
        steps: [
            {
                id: 'step-1',
                title: '执行步骤',
                goal: '执行已批准计划中的第一步。',
                status: 'pending',
                tools: ['read_file'],
                riskLevel: 'low',
                requiresApproval: false,
                expectedOutput: '步骤完成。',
            },
        ],
    });
    return {
        schemaVersion: 1,
        planId: 'plan-1',
        threadId: 'thread-1',
        version: 1,
        status: 'approved',
        userRequest: '请直接执行',
        plan,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
        approvedAt: '2026-05-03T00:00:00.000Z',
        executedAt: null,
        rejectionReason: null,
        errorMessage: null,
        ...overrides,
    };
};
const createFakePlanStore = (record = createPlanRecordForTest()) => ({
    createPendingPlan: async (input) => ({
        ...record,
        ...(input.planId ? { planId: input.planId } : {}),
        threadId: input.threadId,
        userRequest: input.userRequest,
        plan: input.plan,
        status: 'pending_approval',
        version: input.planId ? record.version + 1 : 1,
        approvedAt: null,
        executedAt: null,
        rejectionReason: null,
        errorMessage: null,
    }),
    getPlan: async (input) => ({
        ...record,
        planId: input.planId,
        version: input.version ?? record.version,
    }),
    listPlanVersions: async (planId) => [
        {
            ...record,
            planId,
        },
    ],
    approvePlan: async (input) => ({
        ...record,
        planId: input.planId,
        version: input.version,
        status: 'approved',
    }),
    rejectPlan: async (input) => ({
        ...record,
        planId: input.planId,
        version: input.version,
        status: 'rejected',
        rejectionReason: input.reason ?? null,
    }),
    finishPlan: async (input) => ({
        ...record,
        planId: input.planId,
        version: input.version,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
    }),
    prepareExecution: async (input) => {
        const step = record.plan.steps.find((item) => item.id === input.stepId);
        if (!step) {
            throw new Error(`计划中不存在步骤 ${input.stepId}。`);
        }
        if (record.status !== 'approved' && record.status !== 'executing') {
            throw new Error(`计划当前状态为 ${record.status}。`);
        }
        return {
            record: {
                ...record,
                planId: input.planId,
                version: input.version,
                status: 'executing',
            },
            step,
        };
    },
    close: async () => undefined,
});
const createPlanWorkflowStoreForTest = () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-plan-workflow-runtime-'));
    const store = new LibsqlAgentPlanWorkflowStore({
        url: pathToFileURL(join(directory, 'plan-workflows.db')).href,
        now: () => '2026-05-03T00:00:00.000Z',
    });
    return {
        cleanup: () => rmSync(directory, { force: true, recursive: true }),
        store,
    };
};
describe('LibSQL agent plan store', () => {
    const createStore = () => {
        const directory = mkdtempSync(join(tmpdir(), 'agent-plan-store-'));
        let tick = 0;
        const store = new LibsqlAgentPlanStore({
            url: pathToFileURL(join(directory, 'plans.db')).href,
            now: () => `2026-05-03T00:00:0${tick++}.000Z`,
        });
        return {
            cleanup: () => rmSync(directory, { force: true, recursive: true }),
            store,
        };
    };
    it('stores pending plans and increments versions for regeneration', async () => {
        const { cleanup, store } = createStore();
        const plan = createPlanRecordForTest().plan;
        try {
            const first = await store.createPendingPlan({
                threadId: 'thread-store-1',
                userRequest: '生成计划',
                plan,
            });
            const second = await store.createPendingPlan({
                planId: first.planId,
                threadId: 'thread-store-1',
                userRequest: '重新生成计划',
                plan,
            });
            assert.equal(first.status, 'pending_approval');
            assert.equal(first.version, 1);
            assert.equal(first.threadId, 'thread-store-1');
            assert.equal(first.plan.summary, '执行已批准步骤。');
            assert.equal(second.planId, first.planId);
            assert.equal(second.version, 2);
            assert.equal(second.status, 'pending_approval');
            assert.deepEqual((await store.getPlan({ planId: first.planId })).version, 2);
            assert.deepEqual((await store.listPlanVersions(first.planId)).map((item) => item.version), [2, 1]);
        }
        finally {
            cleanup();
        }
    });
    it('enforces approve, execute, finish, and reject state transitions idempotently', async () => {
        const { cleanup, store } = createStore();
        const plan = createPlanRecordForTest().plan;
        try {
            const pending = await store.createPendingPlan({
                threadId: 'thread-store-2',
                userRequest: '执行计划',
                plan,
            });
            await assert.rejects(() => store.prepareExecution({
                planId: pending.planId,
                version: pending.version,
                stepId: 'step-1',
            }), /必须批准后才能执行/u);
            const approved = await store.approvePlan({
                planId: pending.planId,
                version: pending.version,
            });
            const approvedAgain = await store.approvePlan({
                planId: pending.planId,
                version: pending.version,
            });
            const execution = await store.prepareExecution({
                planId: approved.planId,
                version: approved.version,
                stepId: 'step-1',
            });
            const completed = await store.finishPlan({
                planId: approved.planId,
                version: approved.version,
                status: 'completed',
            });
            assert.equal(approved.status, 'approved');
            assert.equal(approvedAgain.status, 'approved');
            assert.equal(execution.record.status, 'executing');
            assert.equal(execution.step.id, 'step-1');
            assert.equal(completed.status, 'completed');
            assert.ok(completed.executedAt);
            assert.equal((await store.finishPlan({
                planId: approved.planId,
                version: approved.version,
                status: 'completed',
            })).status, 'completed');
            await assert.rejects(() => store.rejectPlan({
                planId: approved.planId,
                version: approved.version,
                reason: '用户拒绝',
            }), /不能拒绝/u);
        }
        finally {
            cleanup();
        }
    });
    it('rejects mismatched versions, missing steps, and rejected plans before execution', async () => {
        const { cleanup, store } = createStore();
        const plan = createPlanRecordForTest().plan;
        try {
            const pending = await store.createPendingPlan({
                threadId: 'thread-store-3',
                userRequest: '校验门禁',
                plan,
            });
            await assert.rejects(() => store.approvePlan({
                planId: pending.planId,
                version: pending.version + 1,
            }), /当前最新版本/u);
            const approved = await store.approvePlan({
                planId: pending.planId,
                version: pending.version,
            });
            await assert.rejects(() => store.prepareExecution({
                planId: approved.planId,
                version: approved.version,
                stepId: 'missing-step',
            }), /不存在步骤/u);
            const rejectedPending = await store.createPendingPlan({
                threadId: 'thread-store-3',
                userRequest: '拒绝计划',
                plan,
            });
            await store.rejectPlan({
                planId: rejectedPending.planId,
                version: rejectedPending.version,
                reason: '不执行',
            });
            const rejectedAgain = await store.rejectPlan({
                planId: rejectedPending.planId,
                version: rejectedPending.version,
                reason: '重复拒绝',
            });
            assert.equal(rejectedAgain.status, 'rejected');
            assert.equal(rejectedAgain.rejectionReason, '不执行');
            await assert.rejects(() => store.prepareExecution({
                planId: rejectedPending.planId,
                version: rejectedPending.version,
                stepId: 'step-1',
            }), /必须批准后才能执行/u);
        }
        finally {
            cleanup();
        }
    });
});
describe('LibSQL agent plan workflow store', () => {
    const createStore = () => {
        const directory = mkdtempSync(join(tmpdir(), 'agent-plan-workflow-store-'));
        let tick = 0;
        const store = new LibsqlAgentPlanWorkflowStore({
            url: pathToFileURL(join(directory, 'plan-workflows.db')).href,
            now: () => `2026-05-03T00:10:${String(tick++).padStart(2, '0')}.000Z`,
        });
        return {
            cleanup: () => rmSync(directory, { force: true, recursive: true }),
            store,
        };
    };
    it('creates a suspended workflow run and projects approval from append-only events', async () => {
        const { cleanup, store } = createStore();
        const record = createPlanRecordForTest({
            status: 'pending_approval',
            approvedAt: null,
        });
        try {
            const created = await store.createForPlan({ record });
            const approvedRecord = createPlanRecordForTest({
                planId: record.planId,
                threadId: record.threadId,
                version: record.version,
                status: 'approved',
            });
            const approved = await store.approvePlan(approvedRecord, 'tester');
            const events = await store.listEvents({
                planId: record.planId,
                version: record.version,
            });
            assert.equal(created.status, 'waiting_approval');
            assert.equal(created.phase, 'approval_gate');
            assert.equal(created.state.suspend.reason, 'plan_approval');
            assert.equal(typeof created.state.suspend.token, 'string');
            assert.equal(created.state.executionCursor, 0);
            assert.equal(created.state.stepIdempotencyKeys['step-1'], `${record.planId}:v${record.version}:step:step-1`);
            assert.equal(approved.status, 'approved');
            assert.equal(approved.phase, 'execute_plan');
            assert.equal(approved.state.approval.approved, true);
            assert.equal(approved.state.suspend.reason, null);
            assert.deepEqual(events.map((event) => event.event.type), [
                'PlanGenerated',
                'Suspended',
                'PlanApproved',
                'Resumed',
            ]);
        }
        finally {
            cleanup();
        }
    });
    it('tracks step idempotency, heartbeat, completion cursor, and finish from event replay', async () => {
        const { cleanup, store } = createStore();
        const record = createPlanRecordForTest({
            status: 'approved',
        });
        try {
            await store.createForPlan({ record });
            await store.approvePlan(record);
            const started = await store.startStep({
                planId: record.planId,
                version: record.version,
                stepId: 'step-1',
                mastraRunId: 'run-1',
            });
            await store.heartbeat({
                planId: record.planId,
                version: record.version,
                stepId: 'step-1',
                phase: 'before_tool',
            });
            const completed = await store.completeStep({
                planId: record.planId,
                version: record.version,
                stepId: 'step-1',
                resultRef: 'run-1',
            });
            const finished = await store.finishPlan({
                planId: record.planId,
                version: record.version,
                status: 'completed',
            });
            const events = await store.listEvents({
                planId: record.planId,
                version: record.version,
            });
            assert.equal(started.status, 'executing');
            assert.equal(started.currentStepId, 'step-1');
            assert.equal(started.mastraRunId, 'run-1');
            assert.equal(completed.state.completedStepIds.includes('step-1'), true);
            assert.equal(completed.state.executionCursor, 1);
            assert.equal(completed.phase, 'validate_result');
            assert.equal(finished.status, 'completed');
            assert.equal(finished.phase, 'finish');
            assert.equal(typeof finished.finishedAt, 'string');
            assert.deepEqual(events.map((event) => event.event.type), [
                'PlanGenerated',
                'Suspended',
                'PlanApproved',
                'Resumed',
                'StepStarted',
                'Heartbeat',
                'Heartbeat',
                'StepCompleted',
                'Heartbeat',
                'PlanFinished',
            ]);
        }
        finally {
            cleanup();
        }
    });
    it('records validator reports and replan deltas as workflow events', async () => {
        const { cleanup, store } = createStore();
        const record = createPlanRecordForTest({
            status: 'approved',
        });
        const report = agentPlanValidationReportSchema.parse({
            status: 'needs_replan',
            summary: '步骤输出缺少验证证据。',
            checkedStepIds: ['step-1'],
            needsReplan: true,
            findings: [
                {
                    stepId: 'step-1',
                    severity: 'medium',
                    title: '验收缺口',
                    detail: '没有看到测试或诊断结果。',
                    retryable: true,
                },
            ],
            acceptance: [
                {
                    criterion: '步骤完成。',
                    passed: false,
                    detail: '缺少可验证结果。',
                },
            ],
        });
        const delta = agentPlanDeltaSchema.parse({
            summary: '补充验证步骤。',
            added: [
                {
                    id: 'verify-step-1',
                    title: '验证执行结果',
                    goal: '读取诊断并确认步骤输出。',
                    status: 'pending',
                    tools: ['get_diagnostics'],
                    riskLevel: 'low',
                    requiresApproval: false,
                    expectedOutput: '验证报告通过。',
                },
            ],
            modified: [],
            removed: [],
        });
        try {
            await store.createForPlan({ record });
            await store.approvePlan(record);
            const reported = await store.reportValidator({
                planId: record.planId,
                version: record.version,
                report,
            });
            const replanned = await store.issueReplan({
                planId: record.planId,
                version: record.version,
                toVersion: 2,
                delta,
            });
            const events = await store.listEvents({
                planId: record.planId,
                version: record.version,
            });
            assert.equal(reported.phase, 'replan');
            assert.equal(reported.state.validator.status, 'needs_replan');
            assert.equal(reported.state.validator.needsReplan, true);
            assert.equal(reported.state.suspend.reason, 'validator_needs_replan');
            assert.equal(replanned.state.replanOfVersion, 1);
            assert.deepEqual(events.map((event) => event.event.type), [
                'PlanGenerated',
                'Suspended',
                'PlanApproved',
                'Resumed',
                'ValidatorReported',
                'Suspended',
                'ReplanIssued',
            ]);
        }
        finally {
            cleanup();
        }
    });
});
const startServer = async (runtime) => {
    const server = createAgentSidecarServer({ runtime });
    await new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('expected TCP server address');
    }
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        }),
    };
};
const parseNdjsonFrames = (body) => body
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
const createTemporaryWorkspace = () => mkdtempSync(join(tmpdir(), 'mastra-workspace-'));
const toRecordForTest = (value) => (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null);
const toWorkspaceToolsConfigRecord = (value) => value
    ? value
    : {};
const readWorkspaceToolsConfigForTest = (workspace) => (workspace && typeof workspace.getToolsConfig === 'function'
    ? toWorkspaceToolsConfigRecord(workspace.getToolsConfig())
    : {});
const isRuntimeEventType = (event, type) => {
    const record = toRecordForTest(event);
    const runtimeEvent = toRecordForTest(record?.event);
    return record?.type === 'agent_event' && runtimeEvent?.type === type;
};
const stripTokenBudgetEvents = (events) => events.filter((event) => !isRuntimeEventType(event, 'acontext.token.checked'));
const findTokenBudgetEvent = (events) => {
    const event = events.find((candidate) => isRuntimeEventType(candidate, 'acontext.token.checked'));
    const record = toRecordForTest(event);
    return toRecordForTest(record?.event);
};
const assertTokenBudgetEvent = (events, expected = {}) => {
    const event = findTokenBudgetEvent(events);
    assert.ok(event, 'token budget event should be emitted');
    assert.equal(event?.projectedInputTokensAvailable, true);
    assert.equal(event?.tokenEstimateMethod, 'char_heuristic');
    assert.equal(typeof event?.projectedInputTokens, 'number');
    assert.equal(typeof event?.inputCharCount, 'number');
    assert.equal(typeof event?.systemPromptCharCount, 'number');
    assert.equal(typeof event?.messageCharCount, 'number');
    assert.equal(typeof event?.toolSchemaCharCount, 'number');
    assert.equal(event?.visibility, 'debug');
    for (const [key, value] of Object.entries(expected)) {
        assert.equal(event?.[key], value);
    }
};
describe('DeepSeek reasoning fetch middleware', () => {
    it('captures non-stream reasoning_content and injects it by sorted tool call ids', async () => {
        clearDeepSeekReasoningStoreForTest();
        const originalFetch = globalThis.fetch;
        const capturedBodies = [];
        let callCount = 0;
        globalThis.fetch = (async (_input, init) => {
            callCount += 1;
            if (callCount === 1) {
                return new Response(JSON.stringify({
                    choices: [{
                            message: {
                                role: 'assistant',
                                reasoning_content: '需要先读取时间。',
                                tool_calls: [{ id: 'tool-b' }, { id: 'tool-a' }],
                            },
                        }],
                }), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            capturedBodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
                headers: { 'content-type': 'application/json' },
            });
        });
        try {
            await runWithDeepSeekReasoningContext({ sessionId: 'session-1', runId: 'run-1' }, async () => {
                const firstResponse = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: '现在几点' }],
                    }),
                });
                await firstResponse.text();
                const secondResponse = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [{
                                role: 'assistant',
                                tool_calls: [{ id: 'tool-a' }, { id: 'tool-b' }],
                            }],
                    }),
                });
                await secondResponse.text();
            });
        }
        finally {
            globalThis.fetch = originalFetch;
            clearDeepSeekReasoningStoreForTest();
        }
        const body = toRecordForTest(capturedBodies[0]);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const assistantMessage = toRecordForTest(messages[0]);
        assert.equal(assistantMessage?.content, '');
        assert.equal(assistantMessage?.reasoning_content, '需要先读取时间。');
    });
    it('normalizes missing DeepSeek message content before sending tool-call history', async () => {
        clearDeepSeekReasoningStoreForTest();
        const originalFetch = globalThis.fetch;
        const capturedBodies = [];
        globalThis.fetch = (async (_input, init) => {
            capturedBodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
                headers: { 'content-type': 'application/json' },
            });
        });
        try {
            await runWithDeepSeekReasoningContext({ sessionId: 'session-content', runId: 'run-content' }, async () => {
                const response = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [
                            { role: 'system', content: '系统提示' },
                            { role: 'user', content: '读取文件' },
                            {
                                role: 'assistant',
                                tool_calls: [{ id: 'tool-content-1' }],
                            },
                            {
                                role: 'tool',
                                tool_call_id: 'tool-content-1',
                                content: null,
                            },
                        ],
                    }),
                });
                await response.text();
            });
        }
        finally {
            globalThis.fetch = originalFetch;
            clearDeepSeekReasoningStoreForTest();
        }
        const body = toRecordForTest(capturedBodies[0]);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const assistantMessage = toRecordForTest(messages[2]);
        const toolMessage = toRecordForTest(messages[3]);
        assert.equal(assistantMessage?.content, '');
        assert.equal(toolMessage?.content, '');
    });
    it('emits sanitized stats from the actual DeepSeek request payload', async () => {
        const originalFetch = globalThis.fetch;
        const payloadStats = [];
        globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
            headers: { 'content-type': 'application/json' },
        }));
        try {
            await runWithDeepSeekReasoningContext({
                sessionId: 'session-payload',
                runId: 'run-payload',
                onRequestPayload: (stats) => {
                    payloadStats.push(stats);
                },
            }, async () => {
                const response = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        model: 'deepseek-reasoner',
                        stream: true,
                        messages: [
                            { role: 'system', content: '系统提示' },
                            { role: 'user', content: '请读取文件' },
                            { role: 'assistant', content: '', reasoning_content: '需要工具' },
                        ],
                        tools: [{
                                type: 'function',
                                function: {
                                    name: 'mcp_call_tool',
                                    description: '调用 MCP 工具',
                                    parameters: {
                                        type: 'object',
                                        properties: {
                                            toolName: { type: 'string' },
                                        },
                                    },
                                },
                            }],
                        response_format: {
                            type: 'json_object',
                        },
                    }),
                });
                await response.text();
            });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
        const stats = toRecordForTest(payloadStats[0]);
        assert.equal(stats?.provider, 'deepseek');
        assert.equal(stats?.model, 'deepseek-reasoner');
        assert.equal(stats?.stream, true);
        assert.equal(stats?.toolCount, 1);
        assert.equal(stats?.reasoningInjected, false);
        assert.equal(stats?.reasoningReplayCharCount, 4);
        assert.equal(typeof stats?.requestBodyCharCount, 'number');
        assert.equal(typeof stats?.projectedInputTokens, 'number');
        assert.ok(Number(stats?.messageCharCount) > 0);
        assert.ok(Number(stats?.toolSchemaCharCount) > 0);
        assert.ok(Number(stats?.responseFormatCharCount) > 0);
        assert.doesNotMatch(JSON.stringify(stats), /系统提示|请读取文件|需要工具/u);
    });
    it('captures streaming reasoning_content across SSE chunks without changing the stream body', async () => {
        clearDeepSeekReasoningStoreForTest();
        const originalFetch = globalThis.fetch;
        const encoder = new TextEncoder();
        const capturedBodies = [];
        let callCount = 0;
        globalThis.fetch = (async (_input, init) => {
            callCount += 1;
            if (callCount === 1) {
                const firstLine = 'data: {"choices":[{"delta":{"reasoning_content":"我需要';
                const secondLine = '查时间","tool_calls":[{"id":"call-2"},{"id":"call-1"}]}}]}\n\n';
                const doneLine = 'data: [DONE]\n\n';
                const body = new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(firstLine));
                        controller.enqueue(encoder.encode(secondLine));
                        controller.enqueue(encoder.encode(doneLine));
                        controller.close();
                    },
                });
                return new Response(body, {
                    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
                });
            }
            capturedBodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
                headers: { 'content-type': 'application/json' },
            });
        });
        let streamedText = '';
        try {
            await runWithDeepSeekReasoningContext({ sessionId: 'session-2', runId: 'run-2' }, async () => {
                const streamResponse = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: '现在几点' }],
                    }),
                });
                streamedText = await streamResponse.text();
                const nextResponse = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [{
                                role: 'assistant',
                                tool_calls: [{ id: 'call-1' }, { id: 'call-2' }],
                            }],
                    }),
                });
                await nextResponse.text();
            });
        }
        finally {
            globalThis.fetch = originalFetch;
            clearDeepSeekReasoningStoreForTest();
        }
        assert.match(streamedText, /我需要查时间/u);
        const body = toRecordForTest(capturedBodies[0]);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const assistantMessage = toRecordForTest(messages[0]);
        assert.equal(assistantMessage?.reasoning_content, '我需要查时间');
    });
    it('persists streaming reasoning_content when the upstream stream is canceled after tool calls', async () => {
        clearDeepSeekReasoningStoreForTest();
        const originalFetch = globalThis.fetch;
        const encoder = new TextEncoder();
        const capturedBodies = [];
        let callCount = 0;
        globalThis.fetch = (async (_input, init) => {
            callCount += 1;
            if (callCount === 1) {
                const body = new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"先调用工具。","tool_calls":[{"id":"call-cancel-1"}]}}]}\n\n'));
                    },
                });
                return new Response(body, {
                    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
                });
            }
            capturedBodies.push(JSON.parse(String(init?.body)));
            return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
                headers: { 'content-type': 'application/json' },
            });
        });
        try {
            await runWithDeepSeekReasoningContext({ sessionId: 'session-cancel', runId: 'run-cancel' }, async () => {
                const streamResponse = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [{ role: 'user', content: '需要工具' }],
                    }),
                });
                const reader = streamResponse.body?.getReader();
                assert.ok(reader);
                const firstChunk = await reader.read();
                assert.equal(firstChunk.done, false);
                await reader.cancel('tool loop advanced');
                const nextResponse = await deepseekReasoningFetch('https://example.com/chat/completions', {
                    method: 'POST',
                    body: JSON.stringify({
                        messages: [{
                                role: 'assistant',
                                tool_calls: [{ id: 'call-cancel-1' }],
                            }],
                    }),
                });
                await nextResponse.text();
            });
        }
        finally {
            globalThis.fetch = originalFetch;
            clearDeepSeekReasoningStoreForTest();
        }
        const body = toRecordForTest(capturedBodies[0]);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const assistantMessage = toRecordForTest(messages[0]);
        assert.equal(assistantMessage?.reasoning_content, '先调用工具。');
    });
});
describe('Agent sidecar request schema', () => {
    it('normalizes nullable optional fields from old Tauri clients', () => {
        const payload = agentSidecarChatRequestSchema.parse({
            sessionId: null,
            mode: null,
            goal: null,
            messages: [],
            workspaceRootPath: null,
            context: [],
        });
        assert.equal(payload.sessionId, undefined);
        assert.equal(payload.mode, undefined);
        assert.equal(payload.goal, undefined);
        assert.equal(payload.workspaceRootPath, null);
    });
    it('accepts omitted optional fields from current Tauri clients', () => {
        const payload = agentSidecarPlanRequestSchema.parse({
            goal: 'run',
            messages: [{ role: 'user', content: 'run' }],
            context: [],
        });
        assert.equal(payload.sessionId, undefined);
        assert.equal(payload.mode, undefined);
        assert.equal(payload.workspaceRootPath, undefined);
        assert.equal(payload.goal, 'run');
    });
    it('normalizes blank optional fields without accepting invalid modes', () => {
        const payload = agentSidecarChatRequestSchema.parse({
            sessionId: '',
            mode: ' ',
            goal: ' ',
            messages: [],
            workspaceRootPath: '',
            context: [],
        });
        assert.equal(payload.sessionId, undefined);
        assert.equal(payload.mode, undefined);
        assert.equal(payload.goal, undefined);
        assert.equal(payload.workspaceRootPath, undefined);
        assert.throws(() => agentSidecarChatRequestSchema.parse({
            mode: 'invalid',
            messages: [],
            context: [],
        }));
    });
    it('requires a non-empty goal for plan and execute requests', () => {
        assert.throws(() => agentSidecarPlanRequestSchema.parse({
            goal: ' ',
            messages: [],
            context: [],
        }));
        assert.throws(() => agentSidecarExecuteRequestSchema.parse({
            goal: null,
            messages: [],
            context: [],
            planId: 'plan-1',
            planVersion: 1,
            planStepId: 'step-1',
        }));
        assert.throws(() => agentSidecarExecuteRequestSchema.parse({
            goal: 'run',
            messages: [],
            context: [],
        }));
    });
    it('keeps valid execute payloads aligned with engine input fields', () => {
        const payload = agentSidecarExecuteRequestSchema.parse({
            sessionId: null,
            mode: 'agent',
            goal: ' run ',
            messages: [{ role: 'user', content: 'run' }],
            workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
            context: [],
            planId: 'plan-1',
            planVersion: 2,
            planStepId: 'step-1',
        });
        assert.equal(payload.sessionId, undefined);
        assert.equal(payload.mode, 'agent');
        assert.equal(payload.goal, 'run');
        assert.equal(payload.messages.length, 1);
        assert.equal(payload.workspaceRootPath, 'D:/com.xiaojianc/my_desktop_app');
        assert.equal(payload.planId, 'plan-1');
        assert.equal(payload.planVersion, 2);
        assert.equal(payload.planStepId, 'step-1');
    });
    it('accepts rollback restore requests with optional nested step paths', () => {
        const payload = agentSidecarRollbackRestoreRequestSchema.parse({
            sessionId: 'rollback-session',
            runId: 'run-1',
            snapshotId: 'run-1',
            step: ['durable-agentic-execution', 'durable-llm-execution'],
        });
        assert.equal(payload.sessionId, 'rollback-session');
        assert.equal(payload.runId, 'run-1');
        assert.equal(payload.snapshotId, 'run-1');
        assert.deepEqual(payload.step, ['durable-agentic-execution', 'durable-llm-execution']);
    });
});
describe('Agent sidecar system prompt', () => {
    it('keeps identity prompt model-aware and concise', () => {
        const prompt = buildSystemPrompt({
            mode: 'agent',
            goal: '回答你是谁',
            messages: [{ role: 'user', content: '你是谁' }],
            context: [],
        }, 'deepseek-v4-pro');
        assert.match(prompt, /当前模型：deepseek-v4-pro/);
        assert.match(prompt, /DeepSeek/);
        assert.doesNotMatch(prompt, /不要自称|由 .* 公司开发/);
    });
    it('allows Claude identity when the current model is Claude', () => {
        const prompt = buildSystemPrompt({
            mode: 'agent',
            goal: '回答你是谁',
            messages: [{ role: 'user', content: '你是谁' }],
            context: [],
        }, 'anthropic/claude-sonnet-4-6');
        assert.match(prompt, /当前模型：anthropic\/claude-sonnet-4-6/);
        assert.match(prompt, /Anthropic/);
        assert.doesNotMatch(prompt, /当前模型不是|不要自称/);
    });
    it('prompts Mastra to use official Tavily MCP tools instead of legacy web wrappers', () => {
        const prompt = buildSystemPrompt({
            mode: 'agent',
            goal: '网络搜索上周的北京天气新闻',
            messages: [{ role: 'user', content: '网络搜索上周的北京天气新闻' }],
            context: [],
        }, 'deepseek-v4-pro');
        assert.match(prompt, /tavily-search/);
        assert.match(prompt, /tavily-extract/);
        assert.match(prompt, /不要调用旧的 web_search \/ web_fetch/u);
        assert.match(prompt, /最终回答仍使用中文/u);
    });
    it('tells Mastra not to read current files for general questions without an explicit path', () => {
        const prompt = buildSystemPrompt({
            mode: 'agent',
            goal: '科学原理如何解释',
            messages: [{ role: 'user', content: '科学原理如何解释' }],
            context: [],
        }, 'deepseek-v4-pro');
        assert.match(prompt, /一般知识问答.*直接回答/u);
        assert.match(prompt, /文件读取工具必须提供明确 path/u);
        assert.match(prompt, /不要用空参数尝试读取“当前文件”/u);
    });
    it('keeps current-file tool context out of the system prompt', () => {
        const prompt = buildSystemPrompt({
            mode: 'agent',
            goal: '解释当前文件',
            messages: [{ role: 'user', content: '解释当前文件' }],
            context: [
                {
                    id: 'current-file:src/app.ts',
                    kind: 'current-file',
                    label: 'app.ts',
                    path: 'src/app.ts',
                    range: null,
                    contentPreview: 'const hidden = true;',
                    redacted: false,
                },
            ],
        }, 'deepseek-v4-pro');
        assert.doesNotMatch(prompt, /const hidden = true/u);
        assert.doesNotMatch(prompt, /src\/app\.ts/u);
    });
    it('caps visible UI context previews before they enter the system prompt', () => {
        const longPreview = `${'上下文'.repeat(800)}TAIL_SHOULD_NOT_ENTER_PROMPT`;
        const prompt = buildSystemPrompt({
            mode: 'agent',
            goal: '解释选中的上下文',
            messages: [{ role: 'user', content: '解释选中的上下文' }],
            context: [
                {
                    id: 'selection:src/app.ts',
                    kind: 'selection',
                    label: 'app.ts selection',
                    path: 'src/app.ts',
                    range: { startLine: 1, endLine: 200 },
                    contentPreview: longPreview,
                    redacted: false,
                },
            ],
        }, 'deepseek-v4-pro');
        assert.match(prompt, /内容已截断/u);
        assert.doesNotMatch(prompt, /TAIL_SHOULD_NOT_ENTER_PROMPT/u);
    });
});
describe('Mastra memory helpers', () => {
    it('stores the default libsql database under app data instead of the current workspace', () => {
        const appDataRoot = mkdtempSync(join(tmpdir(), 'mastra-appdata-'));
        const env = {
            APPDATA: appDataRoot,
        };
        const expectedStorageDirectory = join(appDataRoot, 'com.xiaojianc.Calamex', 'agent-sidecar');
        assert.equal(resolveMastraStorageDirectory(env, 'D:/workspace/my_desktop_app'), expectedStorageDirectory);
        assert.equal(resolveMastraStorageUrl(env, 'D:/workspace/my_desktop_app'), pathToFileURL(join(expectedStorageDirectory, 'mastra.db')).href);
    });
    it('does not auto-enable semantic recall from OPENAI_API_KEY alone', () => {
        assert.equal(resolveSemanticRecallEnabled({
            OPENAI_API_KEY: 'test-key',
        }), false);
        assert.equal(resolveSemanticRecallEnabled({
            AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL: 'openai/text-embedding-3-small',
        }), true);
    });
    it('keeps memory replay small by default with a bounded override', () => {
        assert.equal(resolveMemoryLastMessages({}), 6);
        assert.equal(resolveMemoryLastMessages({
            AGENT_SIDECAR_MEMORY_LAST_MESSAGES: '12',
        }), 12);
        assert.equal(resolveMemoryLastMessages({
            AGENT_SIDECAR_MEMORY_LAST_MESSAGES: '200',
        }), 12);
        assert.equal(resolveMemoryLastMessages({
            AGENT_SIDECAR_MEMORY_LAST_MESSAGES: '1',
        }), 2);
    });
    it('enables observational memory by default and still supports explicit disable', () => {
        assert.equal(resolveObservationalMemoryEnabled({}), true);
        assert.equal(resolveObservationalMemoryEnabled({
            AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL: '1',
        }), true);
        assert.equal(resolveObservationalMemoryEnabled({
            AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL: 'false',
        }), false);
        assert.equal(resolveObservationalMemoryBufferingEnabled({
            AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL_BUFFERING: 'true',
        }), true);
    });
    it('routes observer and reflector to smaller same-provider models by default', () => {
        const openAiBase = createTestModelConfig({
            modelId: 'openai/gpt-5.5',
            providerId: 'openai',
            providerModelId: 'gpt-5.5',
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.example/v1',
            customGateways: [],
            model: new ModelRouterLanguageModel({
                providerId: 'openai',
                modelId: 'gpt-5.5',
                apiKey: 'openai-key',
                url: 'https://api.openai.example/v1',
            }),
        });
        const observer = createMastraObserverModelConfig(openAiBase);
        const reflector = createMastraReflectorModelConfig(openAiBase);
        assert.equal(observer.modelId, 'openai/gpt-5.4-mini');
        assert.equal(observer.providerId, 'openai');
        assert.equal(observer.apiKey, 'openai-key');
        assert.equal(observer.baseUrl, 'https://api.openai.example/v1');
        assert.equal(reflector.modelId, 'openai/gpt-5.4-mini');
        assert.equal(reflector.providerId, 'openai');
        assert.equal(reflector.apiKey, 'openai-key');
        assert.equal(reflector.baseUrl, 'https://api.openai.example/v1');
    });
    it('allows explicit observer and reflector model overrides from env', () => {
        const anthropicBase = createTestModelConfig({
            modelId: 'anthropic/claude-sonnet-4-6',
            providerId: 'anthropic',
            providerModelId: 'claude-sonnet-4-6',
            apiKey: 'anthropic-key',
            baseUrl: 'https://api.anthropic.example',
            customGateways: [],
            model: new ModelRouterLanguageModel({
                providerId: 'anthropic',
                modelId: 'claude-sonnet-4-6',
                apiKey: 'anthropic-key',
                url: 'https://api.anthropic.example',
            }),
        });
        const env = {
            AGENT_SIDECAR_OBSERVER_MODEL: 'anthropic/claude-haiku-4-5',
            AGENT_SIDECAR_REFLECTOR_MODEL: 'anthropic/claude-3-5-haiku-latest',
        };
        const observer = createMastraObserverModelConfig(anthropicBase, env);
        const reflector = createMastraReflectorModelConfig(anthropicBase, env);
        assert.equal(observer.modelId, 'anthropic/claude-haiku-4-5');
        assert.equal(observer.apiKey, 'anthropic-key');
        assert.equal(reflector.modelId, 'anthropic/claude-3-5-haiku-latest');
        assert.equal(reflector.apiKey, 'anthropic-key');
    });
    it('uses stable project UUID from .mastracode/project.json instead of path hash', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'project-uuid-'));
        try {
            const firstUuid = resolveProjectUuid(workspaceRoot);
            assert.equal(typeof firstUuid, 'string');
            assert.match(firstUuid, /^[0-9a-f-]{36}$/);
            // Second call should return same UUID
            const secondUuid = resolveProjectUuid(workspaceRoot);
            assert.equal(secondUuid, firstUuid);
            // Verify .mastracode/project.json was created
            const projectJsonPath = join(workspaceRoot, '.mastracode', 'project.json');
            const content = JSON.parse(readFileSync(projectJsonPath, 'utf8'));
            assert.equal(content.uuid, firstUuid);
            assert.equal(typeof content.createdAt, 'string');
        }
        finally {
            rmSync(workspaceRoot, { recursive: true });
        }
    });
    it('keeps working memory focused on the six core IDE fields', () => {
        const parsed = mastraWorkingMemorySchema.parse({
            currentTask: {
                goal: '修复 sidecar memory',
                phase: 'executing',
                status: 'active',
            },
            constraints: ['不要改 UI'],
            importantFacts: ['当前仓库是桌面 IDE'],
            decisions: ['改用官方 Mastra Memory'],
            openQuestions: ['是否启用 fastembed'],
        });
        assert.equal('sessionSummary' in parsed, false);
        assert.equal('recentFocus' in parsed, false);
        assert.equal('workspaceRootPath' in parsed, false);
    });
    it('creates memory scope with stable project UUID resource', () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'memory-scope-'));
        try {
            const sessionId = 'session-123';
            const scope1 = createMastraMemoryScope({ workspaceRootPath: workspaceRoot }, sessionId);
            assert.equal(scope1.thread, sessionId);
            assert.match(scope1.resource, /^workspace:[0-9a-f-]{36}$/);
            // Second call should produce same resource for same workspace
            const scope2 = createMastraMemoryScope({ workspaceRootPath: workspaceRoot }, sessionId);
            assert.equal(scope2.resource, scope1.resource);
            // Different workspace should produce different resource
            const anotherWorkspace = mkdtempSync(join(tmpdir(), 'another-project-'));
            try {
                const scope3 = createMastraMemoryScope({ workspaceRootPath: anotherWorkspace }, sessionId);
                assert.notEqual(scope3.resource, scope1.resource);
            }
            finally {
                rmSync(anotherWorkspace, { recursive: true });
            }
        }
        finally {
            rmSync(workspaceRoot, { recursive: true });
        }
    });
    it('uses explicit UI thread id as the Mastra memory thread', () => {
        const scope = createMastraMemoryScope({
            threadId: 'ui-thread-1',
        }, 'session-123');
        assert.equal(scope.thread, 'ui-thread-1');
        assert.equal(scope.resource, 'agent-sidecar:session:ui-thread-1');
    });
    it('keeps session-scoped resource stable across turns for the same UI thread', () => {
        const firstScope = createMastraMemoryScope({
            threadId: 'ui-thread-1',
        }, 'sidecar:assistant-1');
        const secondScope = createMastraMemoryScope({
            threadId: 'ui-thread-1',
        }, 'sidecar:assistant-2');
        assert.equal(firstScope.thread, 'ui-thread-1');
        assert.equal(secondScope.thread, 'ui-thread-1');
        assert.equal(firstScope.resource, 'agent-sidecar:session:ui-thread-1');
        assert.equal(secondScope.resource, firstScope.resource);
    });
});
describe('Model output budget helpers', () => {
    it('compacts large structured tool outputs before replaying them to the model', () => {
        const compacted = compactModelOutput({
            result: {
                content: '工具输出'.repeat(2_000),
                rows: Array.from({ length: 40 }, (_, index) => ({ index })),
            },
        }, {
            maxTotalChars: 1_000,
            maxStringChars: 300,
            maxArrayItems: 5,
            maxObjectKeys: 10,
            maxDepth: 5,
        });
        const serialized = JSON.stringify(compacted) ?? '';
        assert.equal(typeof serialized, 'string');
        assert.match(serialized, /内容已截断|modelOutputTruncated/u);
        assert.ok(serialized.length < '工具输出'.repeat(2_000).length);
        assert.match(serialized, /modelOutputOmittedItems/u);
    });
});
describe('Mastra file logger helpers', () => {
    it('creates the log file before FileTransport opens it', () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'mastra-log-'));
        const logFilePath = join(tempRoot, 'nested', 'mastra.log');
        try {
            const ensuredPath = ensureMastraLogFile(logFilePath);
            assert.equal(ensuredPath, logFilePath);
            assert.equal(existsSync(logFilePath), true);
        }
        finally {
            rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
describe('Agent sidecar visible result', () => {
    it('does not expose reasoning blocks in the final assistant text', () => {
        const result = {
            stopReason: 'endTurn',
            lastMessage: {
                content: [
                    {
                        type: 'reasoningBlock',
                        text: '内部推理，不应该进入用户可见回答。',
                    },
                    {
                        type: 'textBlock',
                        text: '这是用户应该看到的回答。',
                    },
                ],
            },
        };
        const visibleText = extractVisibleAgentResultText(result);
        assert.equal(visibleText, '这是用户应该看到的回答。');
        assert.doesNotMatch(visibleText, /Reasoning|内部推理/u);
    });
    it('preserves fenced code formatting when visible text is split across multiple text blocks', () => {
        const result = {
            stopReason: 'endTurn',
            lastMessage: {
                content: [
                    {
                        type: 'textBlock',
                        text: '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\n',
                    },
                    {
                        type: 'textBlock',
                        text: 'Remove-Item .\\666.sh\n```\n',
                    },
                ],
            },
        };
        const visibleText = extractVisibleAgentResultText(result);
        assert.equal(visibleText, '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\nRemove-Item .\\666.sh\n```');
    });
});
describe('Agent runtime configuration', () => {
    it('defaults AGENT_RUNTIME to mastra when unset or blank', () => {
        assert.equal(resolveConfiguredRuntimeName({}), 'mastra');
        assert.equal(resolveConfiguredRuntimeName({ AGENT_RUNTIME: ' ' }), 'mastra');
        assert.equal(createConfiguredRuntime({}).name, 'mastra');
    });
    it('only accepts mastra and rejects unsupported runtime names', () => {
        assert.equal(resolveConfiguredRuntimeName({ AGENT_RUNTIME: 'mastra' }), 'mastra');
        assert.equal(createConfiguredRuntime({ env: { AGENT_RUNTIME: 'mastra' } }).name, 'mastra');
        assert.throws(() => resolveConfiguredRuntimeName({ AGENT_RUNTIME: 'legacy-runtime' }), /Unsupported AGENT_RUNTIME: legacy-runtime/u);
    });
});
describe('Mastra runtime chat', () => {
    it('maps Mastra text chunks and keeps explicit thread context', async () => {
        let capturedMessages;
        let capturedStreamOptions;
        let capturedMcpOptions;
        let capturedModel = null;
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async (options) => {
                capturedMcpOptions = options;
                return {
                    clients: [],
                    configs: [],
                    errors: [],
                    tools: {},
                    disconnectAll: async () => {
                        disconnectCalls += 1;
                    },
                };
            },
            createAgent: (config) => {
                capturedModel = config.model;
                return {
                    stream: async (messages, streamOptions) => {
                        capturedMessages = messages;
                        capturedStreamOptions = streamOptions;
                        return {
                            fullStream: (async function* () {
                                yield {
                                    type: 'text-delta',
                                    runId: 'run-1',
                                    from: 'AGENT',
                                    payload: {
                                        id: 'text-1',
                                        text: '你好',
                                    },
                                };
                                yield {
                                    type: 'text-delta',
                                    runId: 'run-1',
                                    from: 'AGENT',
                                    payload: {
                                        id: 'text-1',
                                        text: '，世界',
                                    },
                                };
                                yield {
                                    type: 'finish',
                                    runId: 'run-1',
                                    from: 'AGENT',
                                    payload: {
                                        stepResult: {
                                            reason: 'stop',
                                        },
                                        output: {
                                            usage: {
                                                inputTokens: 1,
                                                outputTokens: 2,
                                                totalTokens: 3,
                                            },
                                        },
                                        metadata: {},
                                        messages: {
                                            all: [],
                                            user: [],
                                            nonUser: [],
                                        },
                                    },
                                };
                            })(),
                        };
                    },
                    generate: async () => {
                        throw new Error('generate should not be used in Mastra chat test');
                    },
                };
            },
        });
        const streamedEvents = [];
        const abortController = new AbortController();
        const response = await runtime.chat({
            mode: 'ask',
            goal: '请打招呼',
            messages: [
                { role: 'assistant', content: '你好，我可以帮你做什么？' },
                { role: 'user', content: '请打招呼' },
            ],
            context: [],
        }, {
            context: {
                requestId: 'req-123',
                signal: abortController.signal,
                timeoutMs: 1_000,
            },
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        assert.equal(typeof capturedModel, 'object');
        assert.equal(capturedModel?.provider, 'deepseek');
        assert.equal(capturedModel?.modelId, 'deepseek-chat');
        assert.deepEqual(capturedMessages, [
            { role: 'assistant', content: '你好，我可以帮你做什么？' },
            { role: 'user', content: '请打招呼' },
        ]);
        assert.equal(capturedMcpOptions, undefined);
        assert.deepEqual(capturedStreamOptions, {
            abortSignal: abortController.signal,
            runId: 'req-123',
            maxSteps: 1,
            toolChoice: 'none',
        });
        assertTokenBudgetEvent(streamedEvents, {
            runId: 'req-123',
            toolCount: 0,
            mcpToolCount: 0,
            mcpServerCount: 0,
            uiContextToolCount: 0,
            nativeToolCount: 0,
            logToolCount: 0,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: false,
            maxSteps: 1,
            toolChoice: 'none',
            toolLoadStrategy: 'none',
        });
        assert.deepEqual(stripTokenBudgetEvents(streamedEvents), [
            {
                type: 'message_delta',
                text: '你好',
                phase: 'final',
            },
            {
                type: 'message_delta',
                text: '你好，世界',
                phase: 'final',
            },
            {
                type: 'done',
                result: '你好，世界',
                promptTokens: 1,
                completionTokens: 2,
                totalTokens: 3,
                usage: {
                    inputTokens: 1,
                    outputTokens: 2,
                    totalTokens: 3,
                },
            },
        ]);
        assert.deepEqual(response, {
            sessionId: response.sessionId,
            events: streamedEvents,
            result: '你好，世界',
        });
        assert.match(response.sessionId, /^mastra-chat-/u);
        assert.equal(disconnectCalls, 0);
    });
    it('sums official usage across multiple model finish chunks', async () => {
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => { },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () {
                        yield {
                            type: 'finish',
                            runId: 'run-usage',
                            from: 'AGENT',
                            payload: {
                                output: {
                                    usage: {
                                        inputTokens: 10,
                                        outputTokens: 5,
                                        outputTokenDetails: {
                                            textTokens: 3,
                                            reasoningTokens: 2,
                                        },
                                        totalTokens: 15,
                                        reasoningTokens: 2,
                                        raw: {
                                            prompt_tokens: 10,
                                            completion_tokens: 5,
                                            total_tokens: 15,
                                            prompt_cache_hit_tokens: 2,
                                            prompt_cache_miss_tokens: 8,
                                            completion_tokens_details: {
                                                reasoning_tokens: 2,
                                            },
                                        },
                                    },
                                },
                            },
                        };
                        yield {
                            type: 'text-delta',
                            runId: 'run-usage',
                            from: 'AGENT',
                            payload: {
                                id: 'text-usage',
                                text: '完成',
                            },
                        };
                        yield {
                            type: 'finish',
                            runId: 'run-usage',
                            from: 'AGENT',
                            payload: {
                                output: {
                                    usage: {
                                        inputTokens: 20,
                                        outputTokens: 7,
                                        outputTokenDetails: {
                                            textTokens: 6,
                                            reasoningTokens: 1,
                                        },
                                        totalTokens: 27,
                                        reasoningTokens: 1,
                                        raw: {
                                            prompt_tokens: 20,
                                            completion_tokens: 7,
                                            total_tokens: 27,
                                            prompt_cache_hit_tokens: 1,
                                            prompt_cache_miss_tokens: 19,
                                            completion_tokens_details: {
                                                reasoning_tokens: 1,
                                            },
                                        },
                                    },
                                },
                            },
                        };
                    })(),
                }),
                generate: async () => {
                    throw new Error('generate should not be used in Mastra usage aggregation test');
                },
            }),
        });
        const response = await runtime.chat({
            mode: 'ask',
            goal: '汇总 token',
            messages: [
                { role: 'user', content: '汇总 token' },
            ],
            context: [],
        });
        const doneEvent = stripTokenBudgetEvents(response.events).find((event) => event.type === 'done');
        assert.deepEqual(doneEvent, {
            type: 'done',
            result: '完成',
            promptTokens: 30,
            completionTokens: 12,
            totalTokens: 42,
            usage: {
                inputTokens: 30,
                inputTokenDetails: {
                    noCacheTokens: 27,
                    cacheReadTokens: 3,
                    cacheWriteTokens: 0,
                },
                outputTokens: 12,
                outputTokenDetails: {
                    textTokens: 9,
                    reasoningTokens: 3,
                },
                totalTokens: 42,
                reasoningTokens: 3,
            },
        });
    });
    it('uses UI thread context and surfaces OM compression events', async () => {
        let capturedMessages;
        let capturedStreamOptions;
        let capturedAgentMemoryEnabled = false;
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            now: () => '2026-05-03T00:00:00.000Z',
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: (config) => {
                capturedAgentMemoryEnabled = Boolean(config.memory);
                return {
                    stream: async (messages, streamOptions) => {
                        capturedMessages = messages;
                        capturedStreamOptions = streamOptions;
                        return {
                            runId: 'run-om-1',
                            fullStream: (async function* () {
                                yield {
                                    type: 'data-om-activation',
                                    data: {
                                        cycleId: 'om-cycle-1',
                                        operationType: 'observation',
                                        activatedAt: '2026-05-03T00:00:00.000Z',
                                        chunksActivated: 3,
                                        tokensActivated: 32_000,
                                        observationTokens: 900,
                                        messagesActivated: 12,
                                        recordId: 'om-record-1',
                                        threadId: 'ui-thread-1',
                                        generationCount: 0,
                                        triggeredBy: 'threshold',
                                        config: {
                                            messageTokens: 30_000,
                                            observationTokens: 40_000,
                                            scope: 'thread',
                                        },
                                    },
                                };
                                yield {
                                    type: 'text-delta',
                                    runId: 'run-om-1',
                                    payload: {
                                        id: 'text-om-1',
                                        text: '上下文已续上。',
                                    },
                                };
                            })(),
                        };
                    },
                    generate: async () => {
                        throw new Error('generate should not be used in OM chat test');
                    },
                };
            },
        });
        const abortController = new AbortController();
        const response = await runtime.chat({
            mode: 'agent',
            goal: '请总结最新状态',
            threadId: 'ui-thread-1',
            messages: [
                { role: 'assistant', content: '上一轮回复。' },
                { role: 'user', content: '请总结最新状态' },
            ],
            context: [],
        }, {
            context: {
                requestId: 'req-om-1',
                signal: abortController.signal,
            },
        });
        assert.equal(capturedAgentMemoryEnabled, true);
        assert.deepEqual(capturedMessages, [
            { role: 'assistant', content: '上一轮回复。' },
            { role: 'user', content: '请总结最新状态' },
        ]);
        const chatMemoryScope = createMastraMemoryScope({ threadId: 'ui-thread-1' }, response.sessionId);
        assert.deepEqual(capturedStreamOptions, {
            runId: 'req-om-1',
            abortSignal: abortController.signal,
            maxSteps: 10,
            toolChoice: 'auto',
            memory: {
                thread: chatMemoryScope.thread,
                resource: chatMemoryScope.resource,
            },
        });
        assertTokenBudgetEvent(response.events, {
            runId: 'run-om-1',
            toolCount: 0,
            mcpToolCount: 0,
            uiContextToolCount: 0,
            nativeToolCount: 0,
            logToolCount: 0,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: true,
            maxSteps: 1,
            toolChoice: 'none',
        });
        assert.deepEqual(stripTokenBudgetEvents(response.events), [
            {
                type: 'agent_event',
                event: {
                    id: response.events[1] && response.events[1].type === 'agent_event' ? response.events[1].event.id : '',
                    type: 'acontext.memory.compressed',
                    runId: 'run-om-1',
                    sessionId: response.sessionId,
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T00:00:00.000Z',
                    seq: 1,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    operationType: 'observation',
                    tokensActivated: 32_000,
                    observationTokens: 900,
                    messagesActivated: 12,
                    chunksActivated: 3,
                    triggeredBy: 'threshold',
                },
            },
            {
                type: 'message_delta',
                text: '上下文已续上。',
                phase: 'final',
            },
            {
                type: 'done',
                result: '上下文已续上。',
            },
        ]);
        assert.equal(response.result, '上下文已续上。');
        assert.equal(disconnectCalls, 0);
    });
    it('injects Mastra Workspace for workspace-backed chats', async () => {
        const workspaceRoot = createTemporaryWorkspace();
        let capturedWorkspace = null;
        let capturedToolNames = [];
        let capturedStreamOptions;
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: (config) => {
                capturedWorkspace = config.workspace ?? null;
                capturedToolNames = Object.keys(config.tools ?? {});
                return {
                    stream: async (_messages, streamOptions) => {
                        capturedStreamOptions = streamOptions;
                        return {
                            fullStream: (async function* () {
                                yield {
                                    type: 'text-delta',
                                    runId: 'workspace-run-1',
                                    payload: {
                                        id: 'workspace-text-1',
                                        text: 'Workspace tools ready.',
                                    },
                                };
                            })(),
                        };
                    },
                    generate: async () => {
                        throw new Error('generate should not be used in workspace chat test');
                    },
                };
            },
        });
        try {
            const response = await runtime.chat({
                mode: 'agent',
                goal: '检查 workspace tools',
                messages: [{ role: 'user', content: '检查 workspace tools' }],
                workspaceRootPath: workspaceRoot,
                context: [],
            });
            assert.equal(response.result, 'Workspace tools ready.');
            assert.notEqual(capturedWorkspace, null);
            const workspaceToolsConfig = readWorkspaceToolsConfigForTest(capturedWorkspace);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_read_file'), true);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_list_files'), true);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_grep'), true);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_edit_file'), true);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_execute_command'), true);
            assert.equal(capturedToolNames.includes('read_file_window'), false);
            assert.equal(capturedToolNames.includes('grep_in_files'), false);
            assert.equal(capturedToolNames.includes('list_dir'), false);
            assert.equal(capturedToolNames.includes('search_symbols'), false);
            assert.equal(capturedToolNames.includes('apply_file_edits'), false);
            const workspaceMemoryScope = createMastraMemoryScope({ workspaceRootPath: workspaceRoot }, response.sessionId);
            assert.deepEqual(capturedStreamOptions, {
                maxSteps: 10,
                toolChoice: 'auto',
                memory: {
                    thread: workspaceMemoryScope.thread,
                    resource: workspaceMemoryScope.resource,
                },
            });
            assert.equal(disconnectCalls, 0);
        }
        finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
    it('uses Mastra Workspace without exposing duplicated raw MCP file tools', async () => {
        const workspaceRoot = createTemporaryWorkspace();
        let capturedWorkspace = null;
        let capturedToolNames = [];
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {
                    probe_grep: createTool({
                        id: 'probe_grep',
                        description: '正则搜索文件内容',
                        inputSchema: z.object({
                            pattern: z.string(),
                        }),
                        execute: async () => ({
                            matches: [],
                        }),
                    }),
                    probe_search_code: createTool({
                        id: 'probe_search_code',
                        description: '语义代码搜索',
                        inputSchema: z.object({
                            query: z.string(),
                        }),
                        execute: async () => ({
                            results: [],
                        }),
                    }),
                    probe_extract_code: createTool({
                        id: 'probe_extract_code',
                        description: 'AST 提取代码块',
                        inputSchema: z.object({
                            path: z.string(),
                        }),
                        execute: async () => ({
                            blocks: [],
                        }),
                    }),
                    tavily_mcp_tavily_search: createTool({
                        id: 'tavily_mcp_tavily_search',
                        description: '联网搜索',
                        inputSchema: z.object({
                            query: z.string(),
                        }),
                        execute: async () => ({
                            content: [{ type: 'text', text: '搜索完成' }],
                            isError: false,
                        }),
                    }),
                },
                disconnectAll: async () => undefined,
            }),
            createAgent: (config) => {
                capturedWorkspace = config.workspace ?? null;
                capturedToolNames = Object.keys(config.tools ?? {});
                return {
                    stream: async () => ({
                        fullStream: (async function* () {
                            yield {
                                type: 'text-delta',
                                runId: 'workspace-filter-run',
                                payload: {
                                    id: 'workspace-filter-text',
                                    text: '无需读取文件。',
                                },
                            };
                        })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used in workspace MCP duplicate filter test');
                    },
                };
            },
        });
        try {
            await runtime.chat({
                mode: 'ask',
                goal: '请搜索项目代码里的 useAiAssistant',
                messages: [{ role: 'user', content: '请搜索项目代码里的 useAiAssistant' }],
                workspaceRootPath: workspaceRoot,
                context: [],
            });
            const workspaceToolsConfig = readWorkspaceToolsConfigForTest(capturedWorkspace);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_read_file'), true);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_list_files'), true);
            assert.equal(Object.prototype.hasOwnProperty.call(workspaceToolsConfig, 'mastra_workspace_grep'), true);
            assert.equal(capturedToolNames.includes('read_text_file'), false);
            assert.equal(capturedToolNames.includes('probe_grep'), false);
            assert.equal(capturedToolNames.includes('probe_search_code'), false);
            assert.equal(capturedToolNames.includes('probe_extract_code'), false);
            assert.equal(capturedToolNames.includes('tavily_mcp_tavily_search'), false);
            assert.equal(capturedToolNames.includes('read_file_window'), false);
            assert.equal(capturedToolNames.includes('grep_in_files'), false);
            assert.equal(capturedToolNames.includes('list_dir'), false);
            assert.equal(capturedToolNames.includes('search_symbols'), false);
            assert.equal(capturedToolNames.includes('apply_file_edits'), false);
            assert.equal(capturedToolNames.includes('mcp_list_tools'), true);
            assert.equal(capturedToolNames.includes('mcp_call_tool'), true);
        }
        finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
    it('allows a verified approved write path once while preserving stale-file protection', async () => {
        const workspaceRoot = createTemporaryWorkspace();
        writeFileSync(join(workspaceRoot, 'test.sh'), '#!/usr/bin/env bash\nprintf test\n', 'utf8');
        writeFileSync(join(workspaceRoot, 'other.sh'), '#!/usr/bin/env bash\nprintf other\n', 'utf8');
        try {
            const { createMastraWorkspace } = await import('./engines/workspace.js');
            const workspace = await createMastraWorkspace(workspaceRoot, 'write');
            assert.notEqual(workspace, undefined);
            if (!workspace) {
                throw new Error('expected workspace');
            }
            await allowWorkspaceWriteAfterVerifiedRead(workspace, 'test.sh');
            const writeFileConfig = workspace.getToolsConfig()?.mastra_workspace_write_file;
            assert.equal(typeof writeFileConfig?.requireReadBeforeWrite, 'function');
            if (typeof writeFileConfig?.requireReadBeforeWrite !== 'function') {
                throw new Error('expected dynamic requireReadBeforeWrite');
            }
            assert.equal(await writeFileConfig.requireReadBeforeWrite({
                args: { path: 'test.sh' },
                requestContext: {},
                workspace,
            }), false);
            assert.equal(await writeFileConfig.requireReadBeforeWrite({
                args: { path: 'other.sh' },
                requestContext: {},
                workspace,
            }), true);
            writeFileSync(join(workspaceRoot, 'test.sh'), '#!/usr/bin/env bash\nprintf changed\n', 'utf8');
            assert.equal(await writeFileConfig.requireReadBeforeWrite({
                args: { path: 'test.sh' },
                requestContext: {},
                workspace,
            }), true);
        }
        finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
    it('keeps MCP access behind the gateway when no Mastra workspace is available', async () => {
        let capturedToolNames = [];
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {
                    probe_grep: createTool({
                        id: 'probe_grep',
                        description: '正则搜索文件内容',
                        inputSchema: z.object({
                            pattern: z.string(),
                        }),
                        execute: async () => ({
                            matches: [],
                        }),
                    }),
                },
                disconnectAll: async () => undefined,
            }),
            createAgent: (config) => {
                capturedToolNames = Object.keys(config.tools ?? {});
                return {
                    stream: async () => ({
                        fullStream: (async function* () {
                            yield {
                                type: 'text-delta',
                                runId: 'no-workspace-filter-run',
                                payload: {
                                    id: 'no-workspace-filter-text',
                                    text: '无 workspace。',
                                },
                            };
                        })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used in no workspace duplicate filter test');
                    },
                };
            },
        });
        await runtime.chat({
            mode: 'ask',
            goal: '没有 workspace',
            messages: [{ role: 'user', content: '没有 workspace' }],
            context: [],
        });
        assert.equal(capturedToolNames.includes('probe_grep'), false);
        assert.equal(capturedToolNames.includes('mcp_call_tool'), true);
    });
    it('routes Mastra reasoning chunks into agent runtime events instead of final text', async () => {
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            now: () => '2026-05-07T00:00:00.000Z',
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () {
                        yield {
                            type: 'reasoning-delta',
                            runId: 'run-reasoning',
                            from: 'AGENT',
                            payload: {
                                id: 'reasoning-1',
                                text: 'The user wants the raw reasoning in the activity tree.',
                            },
                        };
                        yield {
                            type: 'text-delta',
                            runId: 'run-reasoning',
                            from: 'AGENT',
                            payload: {
                                id: 'text-1',
                                text: '这是最终回答。',
                            },
                        };
                    })(),
                }),
                generate: async () => {
                    throw new Error('generate should not be used in Mastra reasoning test');
                },
            }),
        });
        const streamedEvents = [];
        const abortController = new AbortController();
        const response = await runtime.chat({
            mode: 'ask',
            goal: '测试 reasoning',
            messages: [{ role: 'user', content: '测试 reasoning' }],
            context: [],
        }, {
            context: {
                requestId: 'req-reasoning',
                signal: abortController.signal,
                timeoutMs: 1_000,
            },
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        assertTokenBudgetEvent(streamedEvents, {
            runId: 'req-reasoning',
            toolCount: 0,
            mcpToolCount: 0,
            uiContextToolCount: 0,
            nativeToolCount: 0,
            logToolCount: 0,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: false,
            maxSteps: 1,
            toolChoice: 'none',
        });
        const reasoningEvent = streamedEvents.find((event) => isRuntimeEventType(event, 'agent.reasoning.delta'));
        assert.equal(typeof reasoningEvent, 'object');
        assert.notEqual(reasoningEvent, null);
        assert.equal(reasoningEvent.type, 'agent_event');
        assert.equal(reasoningEvent.event?.type, 'agent.reasoning.delta');
        assert.equal(reasoningEvent.event?.text, 'The user wants the raw reasoning in the activity tree.');
        assert.deepEqual(streamedEvents.filter((event) => event.type === 'message_delta'), [
            {
                type: 'message_delta',
                text: '这是最终回答。',
                phase: 'final',
            },
        ]);
        assert.equal(response.result, '这是最终回答。');
        assert.equal(disconnectCalls, 0);
    });
    it('streams Mastra tool calls into the new runtime activity timeline', async () => {
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    runId: 'run-tool-activity',
                    fullStream: (async function* () {
                        yield {
                            type: 'tool-call',
                            runId: 'run-tool-activity',
                            payload: {
                                toolName: 'web_search',
                                toolCallId: 'tool-call-1',
                                args: {
                                    query: '全球矿产最新动态',
                                    apiKey: 'secret-value',
                                },
                            },
                        };
                        yield {
                            type: 'tool-result',
                            runId: 'run-tool-activity',
                            payload: {
                                toolName: 'web_search',
                                result: {
                                    status: 'success',
                                    summary: '搜索完成',
                                },
                            },
                        };
                        yield {
                            type: 'text-delta',
                            runId: 'run-tool-activity',
                            payload: {
                                id: 'text-tool-activity',
                                text: '已完成搜索。',
                            },
                        };
                    })(),
                }),
                generate: async () => {
                    throw new Error('generate should not be used in Mastra tool runtime test');
                },
            }),
        });
        const streamedEvents = [];
        const response = await runtime.chat({
            mode: 'ask',
            goal: '搜索全球矿产',
            messages: [{ role: 'user', content: '搜索全球矿产' }],
            context: [],
        }, {
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        const runtimeToolEvents = streamedEvents.filter((event) => {
            const candidate = event;
            return candidate.type === 'agent_event'
                && (candidate.event?.type === 'agent.tool.started'
                    || candidate.event?.type === 'agent.tool.completed');
        });
        const startedEvent = runtimeToolEvents[0];
        const completedEvent = runtimeToolEvents[1];
        assert.equal(runtimeToolEvents.length, 2);
        assert.equal(startedEvent.event?.type, 'agent.tool.started');
        assert.equal(startedEvent.event?.toolName, 'web_search');
        assert.equal(startedEvent.event?.toolUseId, 'tool-call-1');
        assert.match(String(startedEvent.event?.inputPreview ?? ''), /全球矿产最新动态/u);
        assert.doesNotMatch(String(startedEvent.event?.inputPreview ?? ''), /secret-value/u);
        assert.equal(completedEvent.event?.type, 'agent.tool.completed');
        assert.equal(completedEvent.event?.toolName, 'web_search');
        assert.equal(completedEvent.event?.toolUseId, 'tool-call-1');
        assert.equal(completedEvent.event?.ok, true);
        assert.match(String(completedEvent.event?.resultPreview ?? ''), /搜索完成/u);
        assert.equal(response.result, '已完成搜索。');
        assert.equal(disconnectCalls, 0);
    });
    it('normalizes Mastra stream errors into the existing error event shape', async () => {
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () {
                        yield {
                            type: 'error',
                            runId: 'run-err',
                            from: 'AGENT',
                            payload: {
                                error: new Error('mastra exploded'),
                            },
                        };
                    })(),
                }),
                generate: async () => {
                    throw new Error('generate should not be used in Mastra chat error test');
                },
            }),
        });
        const response = await runtime.chat({
            mode: 'ask',
            goal: 'hello',
            messages: [{ role: 'user', content: 'hello' }],
            context: [],
        });
        assertTokenBudgetEvent(response.events, {
            toolCount: 0,
            mcpToolCount: 0,
            uiContextToolCount: 0,
            nativeToolCount: 0,
            logToolCount: 0,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: false,
            maxSteps: 1,
            toolChoice: 'none',
        });
        assert.deepEqual(stripTokenBudgetEvents(response.events), [{
                type: 'error',
                message: 'Mastra Agent 执行失败：mastra exploded',
            }]);
        assert.equal(response.result, null);
        assert.equal(disconnectCalls, 0);
    });
});
describe('Mastra native time tools', () => {
    it('keeps provider-facing time tool schemas loose so empty model arguments reach execute', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        assertSchemaAccepts(tools.get_current_time.inputSchema, {});
        assertSchemaAccepts(tools.get_current_time.inputSchema, { input: {} });
        assertSchemaAccepts(tools.get_current_time.inputSchema, { arguments: { timezone: null } });
        assertSchemaAccepts(tools.convert_time.inputSchema, {});
        assertSchemaAccepts(tools.convert_time.inputSchema, {
            arguments: {
                source_timezone: null,
                time: '18:30',
                target_timezone: 'America/New_York',
            },
        });
    });
    it('defaults get_current_time to the configured local timezone', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        const executeCurrentTime = tools.get_current_time.execute;
        assert.equal(typeof executeCurrentTime, 'function');
        if (!executeCurrentTime) {
            throw new Error('get_current_time execute is not available.');
        }
        const result = await executeCurrentTime({}, makeToolExecutionContext());
        assert.deepEqual(result, {
            timezone: 'Asia/Shanghai',
            datetime: '2026-05-09T18:32:45+08:00',
            day_of_week: 'Saturday',
            is_dst: false,
        });
    });
    it('accepts wrapped empty input for get_current_time from model tool calls', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        const executeCurrentTime = tools.get_current_time.execute;
        assert.equal(typeof executeCurrentTime, 'function');
        if (!executeCurrentTime) {
            throw new Error('get_current_time execute is not available.');
        }
        const result = await executeCurrentTime({ input: {} }, makeToolExecutionContext());
        assert.deepEqual(result, {
            timezone: 'Asia/Shanghai',
            datetime: '2026-05-09T18:32:45+08:00',
            day_of_week: 'Saturday',
            is_dst: false,
        });
    });
    it('treats nested null timezone as omitted for get_current_time', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        const executeCurrentTime = tools.get_current_time.execute;
        assert.equal(typeof executeCurrentTime, 'function');
        if (!executeCurrentTime) {
            throw new Error('get_current_time execute is not available.');
        }
        const result = await executeCurrentTime({ input: { timezone: null } }, makeToolExecutionContext());
        assert.deepEqual(result, {
            timezone: 'Asia/Shanghai',
            datetime: '2026-05-09T18:32:45+08:00',
            day_of_week: 'Saturday',
            is_dst: false,
        });
    });
    it('accepts root and arguments null timezone before execute runs', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        const executeCurrentTime = tools.get_current_time.execute;
        assert.equal(typeof executeCurrentTime, 'function');
        if (!executeCurrentTime) {
            throw new Error('get_current_time execute is not available.');
        }
        const rootNullResult = await executeCurrentTime({ timezone: null }, makeToolExecutionContext());
        const argumentsNullResult = await executeCurrentTime({ arguments: { timezone: null } }, makeToolExecutionContext());
        assert.deepEqual(rootNullResult, {
            timezone: 'Asia/Shanghai',
            datetime: '2026-05-09T18:32:45+08:00',
            day_of_week: 'Saturday',
            is_dst: false,
        });
        assert.deepEqual(argumentsNullResult, rootNullResult);
    });
    it('accepts wrapped convert_time timezone fields from model tool calls', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        const executeConvertTime = tools.convert_time.execute;
        assert.equal(typeof executeConvertTime, 'function');
        if (!executeConvertTime) {
            throw new Error('convert_time execute is not available.');
        }
        const result = await executeConvertTime({
            arguments: {
                source_timezone: null,
                time: '18:30',
                target_timezone: 'America/New_York',
            },
        }, makeToolExecutionContext());
        assert.equal(result.target.timezone, 'America/New_York');
        assert.equal(result.target.datetime, '2026-05-09T06:30:00-04:00');
    });
    it('converts wall-clock time between timezones without relying on MCP time', async () => {
        const tools = createMastraTimeTools({
            now: () => new Date('2026-05-09T10:32:45.000Z'),
            localTimezone: 'Asia/Shanghai',
        });
        const executeConvertTime = tools.convert_time.execute;
        assert.equal(typeof executeConvertTime, 'function');
        if (!executeConvertTime) {
            throw new Error('convert_time execute is not available.');
        }
        const result = await executeConvertTime({
            source_timezone: 'Asia/Shanghai',
            time: '18:30',
            target_timezone: 'America/New_York',
        }, makeToolExecutionContext());
        assert.deepEqual(result, {
            source: {
                timezone: 'Asia/Shanghai',
                datetime: '2026-05-09T18:30:00+08:00',
                day_of_week: 'Saturday',
                is_dst: false,
            },
            target: {
                timezone: 'America/New_York',
                datetime: '2026-05-09T06:30:00-04:00',
                day_of_week: 'Saturday',
                is_dst: true,
            },
            time_difference: '-12.0h',
        });
    });
});
describe('Mastra runtime built-in tools', () => {
    it('keeps native time tools available even when no MCP tool is connected', async () => {
        let capturedToolNames = [];
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => undefined,
            }),
            createAgent: (config) => {
                capturedToolNames = Object.keys(config.tools ?? {});
                return {
                    stream: async () => ({
                        fullStream: (async function* () {
                            yield {
                                type: 'text-delta',
                                runId: 'run-native-time-tools',
                                from: 'AGENT',
                                payload: {
                                    id: 'text-native-time-tools',
                                    text: '现在可以继续。',
                                },
                            };
                        })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used in built-in tool runtime test');
                    },
                };
            },
        });
        const response = await runtime.chat({
            mode: 'ask',
            goal: '继续',
            messages: [{ role: 'user', content: '继续' }],
            context: [],
        });
        assert.equal(capturedToolNames.includes('read_current_file'), false);
        assert.equal(capturedToolNames.includes('get_current_time'), true);
        assert.equal(capturedToolNames.includes('convert_time'), true);
        assert.equal(response.result, '现在可以继续。');
    });
    it('stops retrying the same tool class after three consecutive failures', async () => {
        let capturedToolNames = [];
        let blockedErrorMessage = '';
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => undefined,
            }),
            createAgent: (config) => {
                capturedToolNames = Object.keys(config.tools ?? {});
                const blockedTool = config.tools?.mcp_call_tool;
                if (!blockedTool || typeof blockedTool.execute !== 'function') {
                    throw new Error('mcp_call_tool 未正确暴露执行入口。');
                }
                const executeBlockedTool = blockedTool.execute;
                return {
                    stream: async () => {
                        for (let index = 0; index < 3; index += 1) {
                            await assert.rejects(async () => executeBlockedTool({
                                serverName: 'tavily-mcp',
                                toolName: 'tavily_search',
                                arguments: { query: `第 ${index + 1} 次失败` },
                            }, {}));
                        }
                        try {
                            await executeBlockedTool({
                                serverName: 'tavily-mcp',
                                toolName: 'tavily_search',
                                arguments: { query: '第 4 次应被阻断' },
                            }, {});
                        }
                        catch (error) {
                            blockedErrorMessage = error instanceof Error ? error.message : String(error);
                        }
                        return {
                            runId: 'run-tool-stop',
                            fullStream: (async function* () {
                                yield {
                                    type: 'text-delta',
                                    runId: 'run-tool-stop',
                                    payload: {
                                        id: 'tool-stop-text',
                                        text: '已停止重复失败工具。',
                                    },
                                };
                            })(),
                        };
                    },
                    generate: async () => {
                        throw new Error('generate should not be used in repeated tool failure guard test');
                    },
                };
            },
        });
        const response = await runtime.chat({
            mode: 'ask',
            goal: '验证工具失败止损',
            messages: [{ role: 'user', content: '验证工具失败止损' }],
            context: [],
        });
        assert.equal(capturedToolNames.includes('mcp_call_tool'), true);
        assert.match(blockedErrorMessage, /已连续失败 3 次/u);
        assert.match(blockedErrorMessage, /mcp_call_tool:tavily-mcp:tavily_search/u);
        assert.equal(response.result, '已停止重复失败工具。');
    });
    it('exposes read_current_file only when UI provides current-file tool context', async () => {
        let capturedToolNames = [];
        const capturedReadCurrentFileTool = { current: null };
        const setCapturedReadCurrentFileTool = (tool) => {
            capturedReadCurrentFileTool.current = tool;
        };
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => undefined,
            }),
            createAgent: (config) => {
                capturedToolNames = Object.keys(config.tools ?? {});
                const readCurrentFileTool = config.tools?.read_current_file;
                if (readCurrentFileTool && typeof readCurrentFileTool === 'object') {
                    setCapturedReadCurrentFileTool(readCurrentFileTool);
                }
                return {
                    stream: async () => ({
                        fullStream: (async function* () {
                            yield {
                                type: 'text-delta',
                                runId: 'run-current-file-tool',
                                payload: {
                                    id: 'text-current-file-tool',
                                    text: '可以按需读取当前文件。',
                                },
                            };
                        })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used in current-file tool test');
                    },
                };
            },
        });
        await runtime.chat({
            mode: 'ask',
            goal: '解释当前文件',
            messages: [{ role: 'user', content: '解释当前文件' }],
            context: [
                {
                    id: 'current-file:src/app.ts',
                    kind: 'current-file',
                    label: 'app.ts',
                    path: 'src/app.ts',
                    range: null,
                    contentPreview: `${'const enabled = true;\n'.repeat(300)}CURRENT_FILE_TAIL_SHOULD_NOT_REPLAY`,
                    redacted: false,
                },
            ],
        });
        assert.equal(capturedToolNames.includes('read_current_file'), true);
        const readCurrentFileTool = capturedReadCurrentFileTool.current;
        if (!readCurrentFileTool?.execute || !readCurrentFileTool.toModelOutput) {
            throw new Error('read_current_file tool 未正确暴露执行和模型输出压缩入口。');
        }
        assert.equal(typeof readCurrentFileTool.execute, 'function');
        assert.equal(typeof readCurrentFileTool.toModelOutput, 'function');
        const rawOutput = await readCurrentFileTool.execute({}, {});
        const rawSerialized = JSON.stringify(rawOutput) ?? '';
        const modelSerialized = JSON.stringify(readCurrentFileTool.toModelOutput(rawOutput)) ?? '';
        assert.doesNotMatch(rawSerialized, /CURRENT_FILE_TAIL_SHOULD_NOT_REPLAY/u);
        assert.match(rawSerialized, /内容已截断/u);
        assert.doesNotMatch(modelSerialized, /CURRENT_FILE_TAIL_SHOULD_NOT_REPLAY/u);
    });
});
describe('Mastra runtime execute', () => {
    it('exposes MCP gateway tools to Mastra execute and keeps the sidecar event contract', async () => {
        let capturedInstructions = '';
        let capturedMessages;
        let capturedStreamOptions;
        let capturedToolNames = [];
        let disconnectCalls = 0;
        const executionRecord = createPlanRecordForTest();
        const workflowStore = createPlanWorkflowStoreForTest();
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createPlanStore: () => createFakePlanStore(executionRecord),
            createPlanWorkflowStore: () => workflowStore.store,
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {
                    git_read_file: createTool({
                        id: 'git_read_file',
                        description: '读取文件内容',
                        inputSchema: z.object({
                            path: z.string(),
                        }),
                        execute: async () => ({
                            content: [{ type: 'text', text: 'README 内容' }],
                            isError: false,
                        }),
                    }),
                },
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            now: () => '2026-05-03T00:00:00.000Z',
            createExecutionHandle: async (config) => {
                capturedInstructions = config.instructions;
                capturedToolNames = Object.keys(config.tools ?? {});
                return {
                    agent: {
                        stream: async (messages, streamOptions) => {
                            capturedMessages = messages;
                            capturedStreamOptions = streamOptions;
                            return {
                                runId: 'run-execute',
                                cleanup: () => undefined,
                                fullStream: (async function* () {
                                    yield {
                                        type: 'tool-call',
                                        runId: 'run-execute',
                                        from: 'AGENT',
                                        payload: {
                                            toolCallId: 'tool-1',
                                            toolName: 'read_file',
                                            args: {
                                                path: 'README.md',
                                            },
                                        },
                                    };
                                    yield {
                                        type: 'tool-result',
                                        runId: 'run-execute',
                                        from: 'TOOL',
                                        payload: {
                                            toolName: 'read_file',
                                            result: {
                                                content: [{ type: 'text', text: 'README 内容' }],
                                                isError: false,
                                            },
                                        },
                                    };
                                    yield {
                                        type: 'text-delta',
                                        runId: 'run-execute',
                                        from: 'AGENT',
                                        payload: {
                                            id: 'text-execute',
                                            text: '执行完成',
                                        },
                                    };
                                })(),
                            };
                        },
                        generate: async () => {
                            throw new Error('generate should not be used in Mastra execute test');
                        },
                    },
                    workflow: {
                        id: 'durable-agentic-loop',
                        createRun: async () => ({
                            timeTravel: async () => ({ output: { text: '' } }),
                        }),
                    },
                };
            },
        });
        const streamedEvents = [];
        const response = await runtime.execute({
            mode: 'ask',
            goal: '请直接执行',
            messages: [{ role: 'user', content: '请直接执行' }],
            context: [],
            planId: executionRecord.planId,
            planVersion: executionRecord.version,
            planStepId: 'step-1',
        }, {
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        assert.match(capturedInstructions, /Agent 模式要求/u);
        assert.deepEqual(capturedMessages, [
            { role: 'user', content: '请直接执行' },
        ]);
        assert.equal(capturedToolNames.includes('git_read_file'), false);
        assert.equal(capturedToolNames.includes('mcp_call_tool'), true);
        assert.equal(capturedToolNames.includes('mcp_list_tools'), true);
        assert.equal(capturedToolNames.includes('read_current_file'), false);
        assert.equal(capturedToolNames.includes('get_current_time'), true);
        assert.equal(capturedToolNames.includes('convert_time'), true);
        const streamOptions = capturedStreamOptions;
        const executeMemoryScope = createMastraMemoryScope({ threadId: executionRecord.threadId, workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app' }, response.sessionId, { resourceScope: 'session' });
        assert.equal(typeof streamOptions.runId, 'string');
        assert.equal(streamOptions.maxSteps, 10);
        assert.equal(streamOptions.toolChoice, 'auto');
        assert.deepEqual(streamOptions.memory, {
            thread: executeMemoryScope.thread,
            resource: executeMemoryScope.resource,
        });
        assertMastraRequestContext(streamOptions.requestContext, {
            mode: 'agent',
            goal: '请直接执行',
            systemPrompt: capturedInstructions,
            workspaceRootPath: null,
            context: [],
            memoryThreadId: executeMemoryScope.thread,
            memoryResourceId: executeMemoryScope.resource,
            planId: executionRecord.planId,
            planVersion: executionRecord.version,
            planStepId: 'step-1',
            approvedPlan: executionRecord.plan,
        });
        assert.match(executeMemoryScope.resource, /^agent-sidecar:session:/);
        assertTokenBudgetEvent(streamedEvents, {
            runId: 'run-execute',
            toolCount: 6,
            mcpToolCount: 2,
            uiContextToolCount: 0,
            nativeToolCount: 2,
            logToolCount: 2,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: true,
            maxSteps: 10,
            toolChoice: 'auto',
        });
        assert.deepEqual(stripTokenBudgetEvents(streamedEvents), [
            {
                type: 'agent_event',
                event: {
                    id: streamedEvents[1] && typeof streamedEvents[1] === 'object' && streamedEvents[1] !== null && 'event' in streamedEvents[1]
                        ? streamedEvents[1].event.id
                        : '',
                    type: 'rollback.checkpoint.created',
                    runId: 'run-execute',
                    sessionId: response.sessionId,
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T00:00:00.000Z',
                    seq: 1,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    snapshotId: 'run-execute',
                },
            },
            {
                type: 'agent_event',
                event: {
                    id: streamedEvents[2] && typeof streamedEvents[2] === 'object' && streamedEvents[2] !== null && 'event' in streamedEvents[2]
                        ? streamedEvents[2].event.id
                        : '',
                    type: 'agent.tool.started',
                    runId: 'run-execute',
                    sessionId: response.sessionId,
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T00:00:00.000Z',
                    seq: 2,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    toolName: 'read_file',
                    toolUseId: 'tool-1',
                    inputPreview: '{"path":"README.md"}',
                },
            },
            {
                type: 'tool_start',
                toolName: 'read_file',
                input: {
                    path: 'README.md',
                },
            },
            {
                type: 'agent_event',
                event: {
                    id: streamedEvents[4] && typeof streamedEvents[4] === 'object' && streamedEvents[4] !== null && 'event' in streamedEvents[4]
                        ? streamedEvents[4].event.id
                        : '',
                    type: 'agent.tool.completed',
                    runId: 'run-execute',
                    sessionId: response.sessionId,
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T00:00:00.000Z',
                    seq: 3,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    toolName: 'read_file',
                    toolUseId: 'tool-1',
                    ok: true,
                    resultPreview: '{"content":[{"type":"text","text":"README 内容"}],"isError":false}',
                },
            },
            {
                type: 'tool_result',
                toolName: 'read_file',
                output: {
                    content: [{ type: 'text', text: 'README 内容' }],
                    isError: false,
                },
            },
            {
                type: 'message_delta',
                text: '执行完成',
                phase: 'final',
            },
            {
                type: 'done',
                result: '执行完成',
            },
        ]);
        assert.deepEqual(response, {
            sessionId: response.sessionId,
            events: streamedEvents,
            result: '执行完成',
        });
        assert.match(response.sessionId, /^mastra-execute-/u);
        assert.equal(disconnectCalls, 0);
        workflowStore.cleanup();
    });
    it('captures reasoning_content chunks as agent.reasoning.delta events', async () => {
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig({
                modelId: 'deepseek/deepseek-v4-flash',
                providerModelId: 'deepseek-v4-flash',
                model: new ModelRouterLanguageModel({
                    providerId: 'deepseek',
                    modelId: 'deepseek-v4-flash',
                    apiKey: 'test-key',
                    url: 'https://example.com/v1',
                }),
            }),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () {
                        yield {
                            type: 'reasoning-delta',
                            runId: 'test-run-id',
                            from: 'AGENT',
                            payload: {
                                id: 'reasoning-2',
                                text: '我需要调用时间工具。',
                            },
                        };
                        yield {
                            type: 'text-delta',
                            runId: 'test-run-id',
                            from: 'AGENT',
                            payload: {
                                id: 'text-2',
                                text: '今天是星期五。',
                            },
                        };
                    })(),
                    runId: 'test-run-id',
                }),
                generate: async () => ({ text: '' }),
            }),
        });
        const streamedEvents = [];
        const response = await runtime.chat({
            mode: 'ask',
            goal: '今天是星期几',
            messages: [{ role: 'user', content: '今天是星期几' }],
            context: [],
        }, {
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        const toRecordForTest = (value) => (value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null);
        const reasoningEvent = streamedEvents.find((event) => toRecordForTest(event)?.type === 'agent_event'
            && toRecordForTest(toRecordForTest(event)?.event)?.type === 'agent.reasoning.delta');
        assert.ok(reasoningEvent !== undefined, 'reasoning event should be emitted');
        assert.equal(toRecordForTest(toRecordForTest(reasoningEvent)?.event)?.text, '我需要调用时间工具。');
        assert.equal(response.result, '今天是星期五。');
        assert.equal(disconnectCalls, 0);
    });
});
describe('Mastra runtime approval resolution', () => {
    it('resumes a pending approval on the original agent instance while keeping the approval request id opaque to the client', async () => {
        let capturedResumeData;
        let capturedResumeOptions;
        let disconnectCalls = 0;
        const executionRecord = createPlanRecordForTest({
            plan: agentPlanSchema.parse({
                goal: '请修改 README',
                steps: [
                    {
                        id: 'step-1',
                        title: '修改 README',
                        goal: '按用户要求修改 README。',
                        status: 'pending',
                        tools: ['write_file'],
                        riskLevel: 'medium',
                        requiresApproval: true,
                        expectedOutput: 'README 已更新。',
                    },
                ],
            }),
        });
        const workflowStore = createPlanWorkflowStoreForTest();
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createPlanStore: () => createFakePlanStore(executionRecord),
            createPlanWorkflowStore: () => workflowStore.store,
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            now: () => '2026-05-03T00:00:00.000Z',
            createExecutionHandle: async () => ({
                agent: {
                    stream: async () => ({
                        runId: 'approval-run-1',
                        cleanup: () => undefined,
                        fullStream: (async function* () {
                            yield {
                                type: 'tool-call-approval',
                                runId: 'approval-run-1',
                                from: 'AGENT',
                                payload: {
                                    toolCallId: 'tool-approval-1',
                                    toolName: 'write_file',
                                    args: {
                                        path: 'README.md',
                                    },
                                },
                            };
                        })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used in Mastra approval resume test');
                    },
                    resumeStream: async (resumeData, resumeOptions) => {
                        capturedResumeData = resumeData;
                        capturedResumeOptions = resumeOptions;
                        return {
                            runId: 'approval-run-1',
                            cleanup: () => undefined,
                            fullStream: (async function* () {
                                yield {
                                    type: 'tool-result',
                                    runId: 'approval-run-1',
                                    from: 'TOOL',
                                    payload: {
                                        toolName: 'write_file',
                                        result: {
                                            ok: true,
                                        },
                                    },
                                };
                                yield {
                                    type: 'text-delta',
                                    runId: 'approval-run-1',
                                    from: 'AGENT',
                                    payload: {
                                        id: 'approval-text-1',
                                        text: '审批后继续执行',
                                    },
                                };
                            })(),
                        };
                    },
                    approveToolCall: async (approvalOptions) => {
                        throw new Error(`approveToolCall should not be used when resumeStream is available: ${JSON.stringify(approvalOptions)}`);
                    },
                    declineToolCall: async () => {
                        throw new Error('declineToolCall should not be used in Mastra approval resume test');
                    },
                },
                workflow: {
                    id: 'durable-agentic-loop',
                    createRun: async () => ({
                        timeTravel: async () => ({ output: { text: '' } }),
                    }),
                },
            }),
        });
        const initial = await runtime.execute({
            mode: 'agent',
            goal: '请修改 README',
            messages: [{ role: 'user', content: '请修改 README' }],
            context: [],
            planId: executionRecord.planId,
            planVersion: executionRecord.version,
            planStepId: 'step-1',
        });
        assert.equal(initial.result, null);
        assert.equal(initial.events.length, 3);
        assertTokenBudgetEvent(initial.events, {
            runId: 'approval-run-1',
            toolCount: 6,
            mcpToolCount: 2,
            uiContextToolCount: 0,
            nativeToolCount: 2,
            logToolCount: 2,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: true,
            maxSteps: 10,
            toolChoice: 'auto',
        });
        assert.equal(initial.events[0]?.type, 'agent_event');
        assert.equal(initial.events[1]?.type, 'agent_event');
        assert.equal(initial.events[2]?.type, 'approval_required');
        assert.equal(disconnectCalls, 0);
        if (initial.events[2]?.type !== 'approval_required') {
            throw new Error('expected approval_required event');
        }
        const approvalRequestId = initial.events[2].request.id;
        assert.match(approvalRequestId, /^mastra-approval\./u);
        assert.deepEqual(decodeApprovalRequestId(approvalRequestId), {
            runId: 'approval-run-1',
            toolCallId: 'tool-approval-1',
            path: 'README.md',
        });
        const resumed = await runtime.resolveApproval({
            sessionId: initial.sessionId,
            requestId: approvalRequestId,
            decision: 'approve',
        });
        assert.deepEqual(capturedResumeData, {
            approved: true,
        });
        assert.deepEqual(capturedResumeOptions, {
            runId: 'approval-run-1',
            toolCallId: 'tool-approval-1',
        });
        assert.deepEqual(resumed.events, [
            {
                type: 'agent_event',
                event: {
                    id: resumed.events[0] && resumed.events[0].type === 'agent_event'
                        ? resumed.events[0].event.id
                        : '',
                    type: 'agent.tool.completed',
                    runId: 'approval-run-1',
                    sessionId: initial.sessionId,
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T00:00:00.000Z',
                    seq: 0,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    toolName: 'write_file',
                    ok: true,
                    resultPreview: '{"ok":true}',
                },
            },
            {
                type: 'tool_result',
                toolName: 'write_file',
                output: {
                    ok: true,
                },
            },
            {
                type: 'message_delta',
                text: '审批后继续执行',
                phase: 'final',
            },
            {
                type: 'done',
                result: '审批后继续执行',
            },
        ]);
        assert.equal(resumed.result, '审批后继续执行');
        assert.equal(disconnectCalls, 0);
        workflowStore.cleanup();
    });
    it('recreates a storage-backed agent to resume a persisted approval when the in-memory pending map is gone', async () => {
        let capturedResumeData;
        let capturedResumeOptions;
        let disconnectCalls = 0;
        const createRuntime = () => new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                clients: [],
                configs: [],
                errors: [],
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            now: () => '2026-05-03T00:00:00.000Z',
            createResumableAgentHandle: async () => ({
                agent: {
                    stream: async () => ({
                        runId: 'approval-run-restored',
                        cleanup: () => undefined,
                        fullStream: (async function* () {
                            yield {
                                type: 'tool-call-approval',
                                runId: 'approval-run-restored',
                                from: 'AGENT',
                                payload: {
                                    toolCallId: 'tool-restored',
                                    toolName: 'write_file',
                                    args: {
                                        path: 'README.md',
                                    },
                                },
                            };
                        })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used when resuming persisted approval');
                    },
                    resumeStream: async (resumeData, resumeOptions) => {
                        capturedResumeData = resumeData;
                        capturedResumeOptions = resumeOptions;
                        return {
                            runId: 'approval-run-restored',
                            cleanup: () => undefined,
                            fullStream: (async function* () {
                                yield {
                                    type: 'text-delta',
                                    runId: 'approval-run-restored',
                                    from: 'AGENT',
                                    payload: {
                                        id: 'approval-restored-text',
                                        text: '已从持久化审批继续。',
                                    },
                                };
                            })(),
                        };
                    },
                },
            }),
        });
        const initialRuntime = createRuntime();
        const initial = await initialRuntime.chat({
            mode: 'agent',
            goal: '继续当前任务',
            messages: [{ role: 'user', content: '继续当前任务' }],
            context: [],
            threadId: 'thread-restored',
        });
        const approvalEvent = initial.events.find((event) => event.type === 'approval_required');
        assert.equal(approvalEvent?.type, 'approval_required');
        if (approvalEvent?.type !== 'approval_required') {
            throw new Error('expected approval_required event');
        }
        const restartedRuntime = createRuntime();
        const response = await restartedRuntime.resolveApproval({
            sessionId: 'sidecar-persisted-session',
            requestId: approvalEvent.request.id,
            decision: 'reject',
            goal: '继续当前任务',
            messages: [{ role: 'user', content: '继续当前任务' }],
            context: [],
            threadId: 'thread-restored',
        });
        assert.deepEqual(capturedResumeData, {
            approved: false,
        });
        const resumeOptions = capturedResumeOptions;
        assert.deepEqual({
            runId: resumeOptions.runId,
            toolCallId: resumeOptions.toolCallId,
            memory: resumeOptions.memory,
        }, {
            runId: 'approval-run-restored',
            toolCallId: 'tool-restored',
            memory: {
                thread: 'thread-restored',
                resource: 'agent-sidecar:session:thread-restored',
            },
        });
        assert.equal(isMastraRequestContextLike(resumeOptions.requestContext), true);
        if (!isMastraRequestContextLike(resumeOptions.requestContext)) {
            throw new Error('expected Mastra request context');
        }
        assert.equal(resumeOptions.requestContext.get('mode'), 'agent');
        assert.equal(resumeOptions.requestContext.get('goal'), '继续当前任务');
        assert.equal(resumeOptions.requestContext.get('workspaceRootPath'), null);
        assert.deepEqual(resumeOptions.requestContext.get('context'), []);
        assert.equal(resumeOptions.requestContext.get('memoryThreadId'), 'thread-restored');
        assert.equal(resumeOptions.requestContext.get('memoryResourceId'), 'agent-sidecar:session:thread-restored');
        assert.match(String(resumeOptions.requestContext.get('systemPrompt')), /审批拒绝/u);
        assert.equal(response.result, '已从持久化审批继续。');
        assert.equal(disconnectCalls, 0);
    });
    it('verifies the approved target path before resuming a persisted write approval', async () => {
        const workspaceRoot = mkdtempSync(join(tmpdir(), 'mastra-approval-workspace-'));
        writeFileSync(join(workspaceRoot, 'test.sh'), '#!/usr/bin/env bash\nprintf test\n', 'utf8');
        let capturedResumeData;
        try {
            const createRuntime = () => new MastraRuntime({
                readModelConfig: () => createTestModelConfig(),
                createMcpClientBundle: async () => ({
                    clients: [],
                    configs: [],
                    errors: [],
                    tools: {},
                    disconnectAll: async () => undefined,
                }),
                now: () => '2026-05-03T00:00:00.000Z',
                createResumableAgentHandle: async () => ({
                    agent: {
                        stream: async () => ({
                            runId: 'approval-run-read-before-write',
                            cleanup: () => undefined,
                            fullStream: (async function* () {
                                yield {
                                    type: 'tool-call-approval',
                                    runId: 'approval-run-read-before-write',
                                    from: 'AGENT',
                                    payload: {
                                        toolCallId: 'tool-read-before-write',
                                        toolName: 'write_file',
                                        args: {
                                            path: 'test.sh',
                                        },
                                    },
                                };
                            })(),
                        }),
                        generate: async () => {
                            throw new Error('generate should not be used when resuming persisted approval');
                        },
                        resumeStream: async (resumeData) => {
                            capturedResumeData = resumeData;
                            return {
                                runId: 'approval-run-read-before-write',
                                cleanup: () => undefined,
                                fullStream: (async function* () {
                                    yield {
                                        type: 'text-delta',
                                        runId: 'approval-run-read-before-write',
                                        from: 'AGENT',
                                        payload: {
                                            id: 'approval-read-before-write-text',
                                            text: '已恢复写文件审批。',
                                        },
                                    };
                                })(),
                            };
                        },
                    },
                }),
            });
            const initialRuntime = createRuntime();
            const initial = await initialRuntime.chat({
                mode: 'agent',
                goal: '修改 test.sh',
                messages: [{ role: 'user', content: '修改 test.sh' }],
                context: [],
                threadId: 'thread-read-before-write',
                workspaceRootPath: workspaceRoot,
            });
            const approvalEvent = initial.events.find((event) => event.type === 'approval_required');
            assert.equal(approvalEvent?.type, 'approval_required');
            if (approvalEvent?.type !== 'approval_required') {
                throw new Error('expected approval_required event');
            }
            assert.deepEqual(decodeApprovalRequestId(approvalEvent.request.id), {
                runId: 'approval-run-read-before-write',
                toolCallId: 'tool-read-before-write',
                path: 'test.sh',
            });
            const restartedRuntime = createRuntime();
            const response = await restartedRuntime.resolveApproval({
                sessionId: 'sidecar-read-before-write-session',
                requestId: approvalEvent.request.id,
                decision: 'approve',
                goal: '修改 test.sh',
                messages: [{ role: 'user', content: '修改 test.sh' }],
                context: [],
                threadId: 'thread-read-before-write',
                workspaceRootPath: workspaceRoot,
            });
            assert.deepEqual(capturedResumeData, {
                approved: true,
            });
            assert.equal(response.result, '已恢复写文件审批。');
        }
        finally {
            rmSync(workspaceRoot, { recursive: true, force: true });
        }
    });
    it('keeps the existing approval tool_result plus done contract instead of returning a runtime-specific placeholder error', async () => {
        const runtime = new MastraRuntime({
            createAgent: () => {
                throw new Error('createAgent should not be used in Mastra approval test');
            },
            readModelConfig: () => null,
        });
        const streamedEvents = [];
        const response = await runtime.resolveApproval({
            sessionId: 'approval-session',
            requestId: 'approval-1',
            decision: 'approve',
        }, {
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        assert.deepEqual(streamedEvents, [
            {
                type: 'tool_result',
                toolName: 'approval',
                output: {
                    requestId: 'approval-1',
                    decision: 'approve',
                },
            },
            {
                type: 'done',
                result: '审批结果已记录，等待下一次 Agent 执行继续消费。',
            },
        ]);
        assert.deepEqual(response, {
            sessionId: 'approval-session',
            events: streamedEvents,
            result: '审批结果已记录，等待下一次 Agent 执行继续消费。',
        });
    });
});
describe('Mastra runtime plan', () => {
    it('stores a pending plan, emits plan metadata, and keeps plan tools read-only', async () => {
        let capturedMessages;
        let capturedGenerateOptions;
        let capturedModel = null;
        let capturedToolNames = [];
        let capturedInstructions = '';
        let disconnectCalls = 0;
        const plan = agentPlanSchema.parse({
            goal: '完成迁移',
            summary: '迁移 runtime 并补充协议回归。',
            requiresApproval: true,
            steps: [
                {
                    id: 'step-1',
                    title: '抽象 runtime 接口',
                    goal: '把 provider 细节隔离到 sidecar runtime 层。',
                    status: 'pending',
                    tools: ['read_file'],
                    riskLevel: 'low',
                    requiresApproval: false,
                    expectedOutput: '完成 runtime contract 抽象。',
                },
                {
                    id: 'step-2',
                    title: '补协议回归测试',
                    goal: '确认流式事件与 plan 事件保持兼容。',
                    status: 'pending',
                    tools: ['test'],
                    riskLevel: 'medium',
                    requiresApproval: true,
                    expectedOutput: '新增通过的协议测试。',
                },
            ],
        });
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                tools: {
                    git_read_file: createTool({
                        id: 'git_read_file',
                        description: '读取文件内容',
                        inputSchema: z.object({
                            path: z.string(),
                        }),
                        execute: async () => ({
                            content: [{ type: 'text', text: 'README 内容' }],
                            isError: false,
                        }),
                    }),
                    git_write_file: createTool({
                        id: 'git_write_file',
                        description: '写入文件内容',
                        inputSchema: z.object({
                            path: z.string(),
                            content: z.string(),
                        }),
                        execute: async () => ({
                            content: [{ type: 'text', text: '写入完成' }],
                            isError: false,
                        }),
                    }),
                },
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createPlanStore: () => createFakePlanStore(createPlanRecordForTest({
                plan,
                status: 'pending_approval',
            })),
            createAgent: (config) => {
                capturedInstructions = config.instructions;
                capturedModel = config.model;
                capturedToolNames = Object.keys(config.tools ?? {});
                return {
                    stream: async () => ({
                        fullStream: (async function* () { })(),
                    }),
                    generate: async (messages, generateOptions) => {
                        capturedMessages = messages;
                        capturedGenerateOptions = generateOptions;
                        return {
                            object: plan,
                            text: '',
                        };
                    },
                };
            },
        });
        const abortController = new AbortController();
        const streamedEvents = [];
        const response = await runtime.plan({
            mode: 'plan',
            goal: '完成迁移',
            messages: [{ role: 'user', content: '给我一个迁移计划' }],
            context: [],
        }, {
            context: {
                requestId: 'plan-req-1',
                signal: abortController.signal,
                timeoutMs: 1_000,
            },
            onEvent: (event) => {
                streamedEvents.push(event);
            },
        });
        assert.equal(typeof capturedModel, 'object');
        assert.equal(capturedModel?.provider, 'deepseek');
        assert.equal(capturedModel?.modelId, 'deepseek-chat');
        assert.equal(capturedToolNames.includes('git_read_file'), false);
        assert.equal(capturedToolNames.includes('git_write_file'), false);
        assert.equal(capturedToolNames.includes('mcp_call_tool'), true);
        assert.equal(capturedToolNames.includes('mcp_list_tools'), true);
        assert.equal(capturedToolNames.includes('read_current_file'), false);
        assert.equal(capturedToolNames.includes('get_current_time'), true);
        assert.equal(capturedToolNames.includes('convert_time'), true);
        assert.match(capturedInstructions, /json object/u);
        assert.match(capturedInstructions, /根对象必须直接包含 goal 和 steps/u);
        assert.match(capturedInstructions, /短步骤节点/u);
        assert.deepEqual(capturedMessages, [
            { role: 'user', content: '输出格式：返回一个简洁的 json object，根对象必须直接包含 goal、steps；steps 只写短标题节点，不要包裹在 plan/result/data 字段里。\n目标：完成迁移\n给我一个迁移计划' },
        ]);
        const planMemoryScope = createMastraMemoryScope({}, response.sessionId);
        assert.deepEqual(capturedGenerateOptions, {
            abortSignal: abortController.signal,
            runId: 'plan-req-1',
            maxSteps: 10,
            toolChoice: 'auto',
            memory: {
                thread: planMemoryScope.thread,
                resource: planMemoryScope.resource,
            },
            structuredOutput: {
                schema: agentPlanGenerationSchema,
                jsonPromptInjection: true,
            },
        });
        assertTokenBudgetEvent(streamedEvents, {
            runId: 'plan-req-1',
            toolCount: 6,
            mcpToolCount: 2,
            uiContextToolCount: 0,
            nativeToolCount: 2,
            logToolCount: 2,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: true,
            maxSteps: 10,
            toolChoice: 'auto',
        });
        assert.deepEqual(stripTokenBudgetEvents(streamedEvents), [
            {
                type: 'plan_ready',
                planId: 'plan-1',
                threadId: response.sessionId,
                version: 1,
                status: 'pending_approval',
                createdAt: '2026-05-03T00:00:00.000Z',
                updatedAt: '2026-05-03T00:00:00.000Z',
                approvedAt: null,
                executedAt: null,
                rejectionReason: null,
                errorMessage: null,
                plan,
            },
            {
                type: 'done',
                result: '已生成计划：2 个待办事项。',
            },
        ]);
        assert.deepEqual(response, {
            sessionId: response.sessionId,
            events: streamedEvents,
            result: '已生成计划：2 个待办事项。',
        });
        assert.match(response.sessionId, /^mastra-plan-/u);
        assert.equal(disconnectCalls, 0);
    });
    it('uses JSON prompt injection for plan structured output when readonly tools are available', async () => {
        let disconnectCalls = 0;
        let capturedJsonPromptInjection;
        const generatedPlan = agentPlanSchema.parse({
            goal: '讲解人类发展历史',
            summary: '先确定讲解脉络，再分阶段展开。',
            steps: [
                {
                    id: 'step-1',
                    title: '梳理历史分期',
                    goal: '按时间线整理人类发展关键阶段。',
                    status: 'pending',
                    tools: [],
                    riskLevel: 'low',
                    requiresApproval: false,
                    expectedOutput: '得到清晰的人类发展历史分期。',
                },
            ],
        });
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                tools: {
                    git_read_file: createTool({
                        id: 'git_read_file',
                        description: '读取文件内容',
                        inputSchema: z.object({
                            path: z.string(),
                        }),
                        execute: async () => ({
                            content: [{ type: 'text', text: 'README 内容' }],
                            isError: false,
                        }),
                    }),
                },
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () { })(),
                }),
                generate: async (_messages, generateOptions) => {
                    capturedJsonPromptInjection = generateOptions?.structuredOutput?.jsonPromptInjection;
                    if (capturedJsonPromptInjection !== true) {
                        throw new Error('Structured output validation failed: - root: Invalid input: expected object, received undefined');
                    }
                    return {
                        object: generatedPlan,
                        text: '',
                    };
                },
            }),
        });
        const response = await runtime.plan({
            mode: 'plan',
            goal: '讲解人类发展历史',
            messages: [{ role: 'user', content: '讲解人类发展历史' }],
            context: [],
        });
        const planReadyEvent = response.events.find((event) => event.type === 'plan_ready');
        if (planReadyEvent?.type !== 'plan_ready') {
            throw new Error('expected plan_ready event');
        }
        assert.equal(capturedJsonPromptInjection, true);
        assert.equal(planReadyEvent.plan.goal, '讲解人类发展历史');
        assert.equal(response.result, '已生成计划：1 个待办事项。');
        assert.equal(disconnectCalls, 0);
    });
    it('fills the request goal when structured plan output omits the top-level goal', async () => {
        let disconnectCalls = 0;
        const generatedPlan = {
            summary: '迁移 runtime 并补充协议回归。',
            requiresApproval: true,
            steps: [
                {
                    id: 'step-1',
                    title: '抽象 runtime 接口',
                    goal: '把 provider 细节隔离到 sidecar runtime 层。',
                    status: 'planned',
                    tools: 'read_file',
                    files: 'agent-sidecar/src/engines/mastra-runtime.ts',
                    acceptanceCriteria: 'runtime contract 抽象清晰，并且协议回归通过。',
                    riskLevel: 'minor',
                    requiresApproval: 'false',
                    expectedOutput: '完成 runtime contract 抽象。',
                },
            ],
        };
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () { })(),
                }),
                generate: async () => ({
                    object: generatedPlan,
                    text: '',
                }),
            }),
        });
        const response = await runtime.plan({
            mode: 'plan',
            goal: '完成迁移',
            messages: [{ role: 'user', content: '给我一个迁移计划' }],
            context: [],
        });
        const planReadyEvent = response.events.find((event) => event.type === 'plan_ready');
        if (planReadyEvent?.type !== 'plan_ready') {
            throw new Error('expected plan_ready event');
        }
        assert.equal(planReadyEvent.plan.goal, '完成迁移');
        assert.equal(planReadyEvent.plan.summary, '迁移 runtime 并补充协议回归。');
        assert.equal(planReadyEvent.plan.steps[0]?.status, 'pending');
        assert.equal(planReadyEvent.plan.steps[0]?.riskLevel, 'medium');
        assert.equal(planReadyEvent.plan.steps[0]?.requiresApproval, false);
        assert.deepEqual(planReadyEvent.plan.steps[0]?.tools, ['read_file']);
        assert.deepEqual(planReadyEvent.plan.steps[0]?.files, ['agent-sidecar/src/engines/mastra-runtime.ts']);
        assert.deepEqual(planReadyEvent.plan.steps[0]?.acceptanceCriteria, ['runtime contract 抽象清晰，并且协议回归通过。']);
        assert.equal(response.result, '已生成计划：1 个待办事项。');
        assert.equal(disconnectCalls, 0);
    });
    it('unwraps common structured plan envelope fields before strict persistence validation', async () => {
        let disconnectCalls = 0;
        const generatedPlan = {
            summary: '迁移 runtime 并补充协议回归。',
            requiresApproval: true,
            steps: [
                {
                    id: 'step-1',
                    title: '抽象 runtime 接口',
                    goal: '把 provider 细节隔离到 sidecar runtime 层。',
                    status: 'pending',
                    tools: ['read_file'],
                    riskLevel: 'low',
                    requiresApproval: false,
                    expectedOutput: '完成 runtime contract 抽象。',
                },
            ],
        };
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () { })(),
                }),
                generate: async () => ({
                    object: {
                        plan: generatedPlan,
                    },
                    text: '',
                }),
            }),
        });
        const response = await runtime.plan({
            mode: 'plan',
            goal: '完成迁移',
            messages: [{ role: 'user', content: '给我一个迁移计划' }],
            context: [],
        });
        const planReadyEvent = response.events.find((event) => event.type === 'plan_ready');
        if (planReadyEvent?.type !== 'plan_ready') {
            throw new Error('expected plan_ready event');
        }
        assert.equal(planReadyEvent.plan.goal, '完成迁移');
        assert.equal(planReadyEvent.plan.steps[0]?.id, 'step-1');
        assert.equal(response.result, '已生成计划：1 个待办事项。');
        assert.equal(disconnectCalls, 0);
    });
    it('returns the existing sidecar error shape when Mastra plan output is invalid', async () => {
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createMcpClientBundle: async () => ({
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () { })(),
                }),
                generate: async () => ({
                    object: {
                        goal: 'bad plan',
                        steps: [],
                    },
                }),
            }),
        });
        const response = await runtime.plan({
            mode: 'plan',
            goal: 'bad plan',
            messages: [{ role: 'user', content: '给我一个计划' }],
            context: [],
        });
        assertTokenBudgetEvent(response.events, {
            toolCount: 6,
            mcpToolCount: 2,
            uiContextToolCount: 0,
            nativeToolCount: 2,
            logToolCount: 2,
            workspaceEnabled: false,
            browserEnabled: false,
            memoryEnabled: true,
            maxSteps: 10,
            toolChoice: 'auto',
        });
        assert.deepEqual(stripTokenBudgetEvents(response.events), [{
                type: 'error',
                message: 'Mastra structured output 没有返回有效 AgentPlan，计划未生成。',
            }]);
        assert.equal(response.result, null);
        assert.equal(disconnectCalls, 0);
    });
    it('runs a readonly validator agent and persists structured validation reports', async () => {
        let capturedInstructions = '';
        let capturedGenerateOptions;
        let disconnectCalls = 0;
        const executionRecord = createPlanRecordForTest({
            status: 'executing',
        });
        const workflowStore = createPlanWorkflowStoreForTest();
        const report = agentPlanValidationReportSchema.parse({
            status: 'needs_replan',
            summary: '缺少验证证据。',
            checkedStepIds: ['step-1'],
            needsReplan: true,
            findings: [
                {
                    stepId: 'step-1',
                    severity: 'medium',
                    title: '缺少验证',
                    detail: '没有看到测试或诊断输出。',
                    retryable: true,
                },
            ],
            acceptance: [
                {
                    criterion: '步骤完成。',
                    passed: false,
                    detail: '没有足够证据。',
                },
            ],
        });
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createPlanStore: () => createFakePlanStore(executionRecord),
            createPlanWorkflowStore: () => workflowStore.store,
            createMcpClientBundle: async () => ({
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: (config) => {
                capturedInstructions = config.instructions;
                return {
                    stream: async () => ({
                        fullStream: (async function* () { })(),
                    }),
                    generate: async (_messages, options) => {
                        capturedGenerateOptions = options;
                        return {
                            object: report,
                            text: '',
                        };
                    },
                };
            },
        });
        const response = await runtime.validatePlan({
            mode: 'agent',
            goal: '验证执行结果',
            messages: [{ role: 'user', content: '验证执行结果' }],
            context: [],
            planId: executionRecord.planId,
            planVersion: executionRecord.version,
        });
        const events = await workflowStore.store.listEvents({
            planId: executionRecord.planId,
            version: executionRecord.version,
        });
        const validateMemoryScope = createMastraMemoryScope({ threadId: executionRecord.threadId, workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app' }, response.sessionId, { resourceScope: 'session' });
        assert.match(capturedInstructions, /Validator Agent/u);
        assert.deepEqual(capturedGenerateOptions, {
            runId: capturedGenerateOptions && typeof capturedGenerateOptions === 'object' && 'runId' in capturedGenerateOptions
                ? capturedGenerateOptions.runId
                : '',
            maxSteps: 8,
            toolChoice: 'auto',
            structuredOutput: {
                schema: agentPlanValidationReportSchema,
            },
            memory: {
                thread: validateMemoryScope.thread,
                resource: validateMemoryScope.resource,
            },
        });
        assert.match(validateMemoryScope.resource, /^agent-sidecar:session:/);
        assert.equal(response.result, '验证完成：缺少验证证据。，需要重新规划。');
        assert.deepEqual(events.map((event) => event.event.type), [
            'PlanGenerated',
            'Suspended',
            'PlanApproved',
            'Resumed',
            'ValidatorReported',
            'Suspended',
        ]);
        assert.equal(disconnectCalls, 0);
        workflowStore.cleanup();
    });
    it('runs a replanner agent, applies delta plan, and creates the next pending version', async () => {
        let disconnectCalls = 0;
        const executionRecord = createPlanRecordForTest({
            status: 'executing',
        });
        const workflowStore = createPlanWorkflowStoreForTest();
        const delta = agentPlanDeltaSchema.parse({
            summary: '补充验证步骤。',
            added: [
                {
                    id: 'verify-step-1',
                    title: '验证执行结果',
                    goal: '读取诊断并确认输出。',
                    status: 'pending',
                    tools: ['get_diagnostics'],
                    riskLevel: 'low',
                    requiresApproval: false,
                    expectedOutput: '验证通过。',
                },
            ],
            modified: [
                {
                    id: 'step-1',
                    patch: {
                        title: '执行并保留证据',
                        acceptanceCriteria: ['步骤完成。', '保留验证证据。'],
                    },
                },
            ],
            removed: [],
        });
        const runtime = new MastraRuntime({
            readModelConfig: () => createTestModelConfig(),
            createPlanStore: () => createFakePlanStore(executionRecord),
            createPlanWorkflowStore: () => workflowStore.store,
            createMcpClientBundle: async () => ({
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createAgent: () => ({
                stream: async () => ({
                    fullStream: (async function* () { })(),
                }),
                generate: async () => ({
                    object: delta,
                    text: '',
                }),
            }),
        });
        const response = await runtime.replanPlan({
            mode: 'plan',
            goal: '根据验证结果重新规划',
            messages: [{ role: 'user', content: '根据验证结果重新规划' }],
            context: [],
            planId: executionRecord.planId,
            planVersion: executionRecord.version,
        });
        const planReadyEvent = response.events.find((event) => event.type === 'plan_ready');
        const oldWorkflowEvents = await workflowStore.store.listEvents({
            planId: executionRecord.planId,
            version: executionRecord.version,
        });
        const nextWorkflow = await workflowStore.store.getWorkflow({
            planId: executionRecord.planId,
            version: 2,
        });
        if (planReadyEvent?.type !== 'plan_ready') {
            throw new Error('expected plan_ready event');
        }
        assert.equal(planReadyEvent.version, 2);
        assert.equal(planReadyEvent.status, 'pending_approval');
        assert.equal(planReadyEvent.plan.steps[0]?.id, 'step-1');
        assert.equal(planReadyEvent.plan.steps[0]?.title, '执行并保留证据');
        assert.equal(planReadyEvent.plan.steps[1]?.id, 'verify-step-1');
        assert.equal(nextWorkflow.state.replanOfVersion, 1);
        assert.deepEqual(oldWorkflowEvents.map((event) => event.event.type), [
            'PlanGenerated',
            'Suspended',
            'PlanApproved',
            'Resumed',
            'ReplanIssued',
        ]);
        assert.equal(disconnectCalls, 0);
        workflowStore.cleanup();
    });
    it('restores a persisted checkpoint through Mastra timeTravel and preserves rollback runtime events', async () => {
        let capturedRollbackOptions;
        let disconnectCalls = 0;
        const runtime = new MastraRuntime({
            now: () => '2026-05-03T01:00:00.000Z',
            readModelConfig: () => createTestModelConfig(),
            loadExecutionSnapshot: async () => ({
                status: 'success',
                requestContext: {
                    systemPrompt: '恢复前的 system prompt',
                    workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
                },
            }),
            createMcpClientBundle: async () => ({
                tools: {},
                disconnectAll: async () => {
                    disconnectCalls += 1;
                },
            }),
            createExecutionHandle: async () => ({
                agent: {
                    stream: async () => ({
                        runId: 'run-restore-1',
                        cleanup: () => undefined,
                        fullStream: (async function* () { })(),
                    }),
                    generate: async () => {
                        throw new Error('generate should not be used in restore test');
                    },
                },
                workflow: {
                    id: 'durable-agentic-loop',
                    createRun: async () => ({
                        timeTravel: async (rollbackOptions) => {
                            capturedRollbackOptions = rollbackOptions;
                            return {
                                output: {
                                    text: '已恢复到最近 checkpoint。',
                                },
                            };
                        },
                    }),
                },
            }),
        });
        const response = await runtime.restoreCheckpoint({
            sessionId: 'rollback-session',
            runId: 'run-restore-1',
            snapshotId: 'run-restore-1',
        });
        const rollbackOptions = capturedRollbackOptions;
        assert.deepEqual(rollbackOptions.step, ['durable-agentic-execution', 'durable-llm-execution']);
        assertMastraRequestContext(rollbackOptions.requestContext, {
            systemPrompt: '恢复前的 system prompt',
            workspaceRootPath: 'D:/com.xiaojianc/my_desktop_app',
        });
        assert.deepEqual(response.events, [
            {
                type: 'agent_event',
                event: {
                    id: response.events[0] && response.events[0].type === 'agent_event' ? response.events[0].event.id : '',
                    type: 'rollback.restore.started',
                    runId: 'run-restore-1',
                    sessionId: 'rollback-session',
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T01:00:00.000Z',
                    seq: 0,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    snapshotId: 'run-restore-1',
                },
            },
            {
                type: 'agent_event',
                event: {
                    id: response.events[1] && response.events[1].type === 'agent_event' ? response.events[1].event.id : '',
                    type: 'rollback.restore.completed',
                    runId: 'run-restore-1',
                    sessionId: 'rollback-session',
                    agentId: 'calamex-agent-sidecar',
                    timestamp: '2026-05-03T01:00:00.000Z',
                    seq: 1,
                    schemaVersion: 1,
                    redacted: true,
                    visibility: 'user',
                    level: 'info',
                    snapshotId: 'run-restore-1',
                    savedAsLatest: true,
                    message: '已恢复到最近 checkpoint。',
                },
            },
            {
                type: 'done',
                result: '已恢复到最近 checkpoint。',
            },
        ]);
        assert.equal(response.result, '已恢复到最近 checkpoint。');
        assert.equal(disconnectCalls, 0);
    });
});
describe('Agent sidecar protocol golden tests', () => {
    it('streams deterministic NDJSON frames from the injected runtime without changing response aggregation', async () => {
        let capturedInput;
        const runtimeEvents = [
            {
                type: 'message_delta',
                text: 'hello',
            },
            {
                type: 'message_delta',
                text: 'hello world',
            },
            {
                type: 'done',
                result: 'hello world',
            },
        ];
        const runtime = createFakeRuntime({
            chat: async (input, options) => {
                capturedInput = input;
                for (const event of runtimeEvents) {
                    options?.onEvent?.(event);
                }
                return {
                    sessionId: 'session-fixed',
                    events: [...runtimeEvents],
                    result: 'hello world',
                };
            },
        });
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/chat/stream`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    sessionId: null,
                    mode: ' ',
                    goal: ' ',
                    messages: [{ role: 'user', content: 'hello world' }],
                    workspaceRootPath: '',
                    context: [],
                }),
            });
            assert.equal(response.status, 200);
            const frames = parseNdjsonFrames(await response.text());
            assert.deepEqual(frames, [
                { type: 'event', event: runtimeEvents[0] },
                { type: 'event', event: runtimeEvents[1] },
                { type: 'event', event: runtimeEvents[2] },
                {
                    type: 'response',
                    response: {
                        sessionId: 'session-fixed',
                        events: [...runtimeEvents],
                        result: 'hello world',
                    },
                },
            ]);
            assert.deepEqual(capturedInput, {
                mode: 'ask',
                goal: 'hello world',
                messages: [{ role: 'user', content: 'hello world' }],
                context: [],
            });
        }
        finally {
            await server.close();
        }
    });
    it('keeps streamed runtime errors inside the sidecar error frame', async () => {
        const runtime = createFakeRuntime({
            chat: async (_input, options) => {
                options?.onEvent?.({
                    type: 'message_delta',
                    text: 'partial',
                });
                throw new Error('runtime exploded');
            },
        });
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/chat/stream`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: 'hello world' }],
                    context: [],
                }),
            });
            assert.equal(response.status, 200);
            assert.deepEqual(parseNdjsonFrames(await response.text()), [
                {
                    type: 'event',
                    event: {
                        type: 'message_delta',
                        text: 'partial',
                    },
                },
                {
                    type: 'error',
                    error: 'runtime exploded',
                },
            ]);
        }
        finally {
            await server.close();
        }
    });
    it('accepts warmup requests without invoking the runtime', async () => {
        const runtime = createFakeRuntime();
        const server = await startServer(runtime);
        try {
            const response = await fetch(`${server.baseUrl}/agent/warmup`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({}),
            });
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(typeof payload.durationMs, 'number');
            assert.deepEqual({
                ...payload,
                durationMs: 0,
            }, {
                ok: true,
                providerId: null,
                origin: null,
                statusCode: null,
                durationMs: 0,
                skipped: true,
                reason: 'missing_model_config',
            });
        }
        finally {
            await server.close();
        }
    });
    it('returns persisted plan records through POST and GET query routes', async () => {
        const record = createPlanRecordForTest({
            planId: 'plan-query-1',
            version: 2,
            status: 'approved',
        });
        const capturedInputs = [];
        const runtime = createFakeRuntime({
            getPlan: async (input) => {
                capturedInputs.push(input);
                return {
                    sessionId: 'plan-query-session',
                    events: [
                        {
                            type: 'plan_record',
                            record: {
                                ...record,
                                planId: input.planId,
                                version: input.version ?? record.version,
                            },
                            versions: [
                                {
                                    ...record,
                                    version: 2,
                                },
                                {
                                    ...record,
                                    version: 1,
                                },
                            ],
                        },
                        {
                            type: 'done',
                            result: '计划记录已加载。',
                        },
                    ],
                    result: '计划记录已加载。',
                };
            },
        });
        const server = await startServer(runtime);
        try {
            const postResponse = await fetch(`${server.baseUrl}/agent/plan/query`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    planId: 'plan-query-1',
                    version: 2,
                }),
            });
            const getResponse = await fetch(`${server.baseUrl}/agent/plan/plan-query-1?version=2`);
            assert.equal(postResponse.status, 200);
            assert.equal(getResponse.status, 200);
            assert.deepEqual(capturedInputs, [
                {
                    planId: 'plan-query-1',
                    version: 2,
                },
                {
                    planId: 'plan-query-1',
                    version: 2,
                },
            ]);
            const postPayload = await postResponse.json();
            const getPayload = await getResponse.json();
            assert.equal(postPayload.events[0].type, 'plan_record');
            assert.equal(postPayload.events[0].record.planId, 'plan-query-1');
            assert.equal(postPayload.events[0].versions.length, 2);
            assert.deepEqual(getPayload, postPayload);
        }
        finally {
            await server.close();
        }
    });
    it('reports injected runtime metadata on health without changing the protocol field', async () => {
        const server = await startServer(createFakeRuntime());
        try {
            const response = await fetch(`${server.baseUrl}/health`);
            assert.equal(response.status, 200);
            const payload = await response.json();
            assert.equal(payload.ok, true);
            assert.equal(payload.status, 'ready');
            assert.equal(payload.engine, 'fake-runtime');
            assert.equal(payload.version, 'test-version');
            assert.equal(payload.protocolVersion, '7');
            assert.equal(payload.implementationVersion, 'deepseek-reasoning-transport-v6-plan-history');
            assert.equal(typeof payload.mcp?.configuredServers, 'number');
            assert.equal(Array.isArray(payload.mcp?.serverNames), true);
            assert.equal(Array.isArray(payload.mcp?.errors), true);
        }
        finally {
            await server.close();
        }
    });
});
