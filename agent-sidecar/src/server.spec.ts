import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { MastraModelConfig } from '@mastra/core/llm';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { buildSystemPrompt, extractVisibleAgentResultText } from './engines/agent-runtime-helpers.js';
import {
  createMastraMemoryScope,
  mastraWorkingMemorySchema,
  resolveMastraStorageDirectory,
  resolveMastraStorageUrl,
  resolveMemoryLastMessages,
  resolveObservationalMemoryBufferingEnabled,
  resolveObservationalMemoryEnabled,
  resolveProjectUuid,
  resolveSemanticRecallEnabled,
} from './engines/mastra-memory.js';
import {
  MastraRuntime,
} from './engines/mastra-runtime.js';
import {
  LibsqlAgentPlanStore,
  type IAgentPlanStore,
  type TAgentPlanRecord,
} from './engines/plan-store.js';
import { LibsqlAgentPlanWorkflowStore } from './engines/plan-workflow-store.js';
import {
  createConfiguredRuntime,
  resolveConfiguredRuntimeName,
  type IAgentSidecarRuntime,
} from './engines/runtime.js';
import {
  clearDeepSeekReasoningStoreForTest,
  deepseekReasoningFetch,
  runWithDeepSeekReasoningContext,
} from './models/deepseek-reasoning-fetch.js';
import { compactModelOutput } from './models/model-output-budget.js';
import {
  agentPlanDeltaSchema,
  agentPlanValidationReportSchema,
} from './schemas/plan-workflow.js';
import { agentPlanGenerationSchema, agentPlanSchema } from './schemas/plan.js';
import {
  agentSidecarChatRequestSchema,
  agentSidecarExecuteRequestSchema,
  agentSidecarPlanRequestSchema,
  agentSidecarRollbackRestoreRequestSchema,
  createAgentSidecarServer,
} from './server.js';
import { createMastraFileTools } from './tools/file-primitives.js';
import { ensureMastraLogFile } from './tools/log.js';
import { createMastraTimeTools } from './tools/time.js';

const unsupportedRuntimeResponse = async (
  ...args: Parameters<IAgentSidecarRuntime['chat']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['chat']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedApprovalResolution = async (
  ...args: Parameters<IAgentSidecarRuntime['resolveApproval']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['resolveApproval']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const isMastraRequestContextLike = (value: unknown): value is {
  get: (key: string) => unknown;
  toJSON: () => unknown;
} => Boolean(
  value
  && typeof value === 'object'
  && 'get' in value
  && typeof value.get === 'function'
  && 'toJSON' in value
  && typeof value.toJSON === 'function',
);

const isZodLikeSchema = (value: unknown): value is {
  safeParse: (input: unknown) => { success: boolean };
} => Boolean(
  value
  && typeof value === 'object'
  && 'safeParse' in value
  && typeof value.safeParse === 'function',
);

const assertSchemaAccepts = (schema: unknown, input: unknown): void => {
  assert.equal(isZodLikeSchema(schema), true);

  if (!isZodLikeSchema(schema)) {
    throw new Error('schema does not support safeParse');
  }

  assert.equal(schema.safeParse(input).success, true);
};

const assertMastraRequestContext = (
  value: unknown,
  expected: Record<string, unknown>,
): void => {
  assert.equal(isMastraRequestContextLike(value), true);

  if (!isMastraRequestContextLike(value)) {
    return;
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.deepEqual(value.get(key), expectedValue);
  }

  assert.deepEqual(value.toJSON(), expected);
};

const unsupportedRollbackRestore = async (
  ...args: Parameters<IAgentSidecarRuntime['restoreCheckpoint']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['restoreCheckpoint']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedPlanApproval = async (
  ...args: Parameters<IAgentSidecarRuntime['approvePlan']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['approvePlan']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedPlanQuery = async (
  ...args: Parameters<IAgentSidecarRuntime['getPlan']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['getPlan']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedPlanReject = async (
  ...args: Parameters<IAgentSidecarRuntime['rejectPlan']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['rejectPlan']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedPlanFinish = async (
  ...args: Parameters<IAgentSidecarRuntime['finishPlan']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['finishPlan']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedPlanValidation = async (
  ...args: Parameters<IAgentSidecarRuntime['validatePlan']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['validatePlan']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const unsupportedPlanReplan = async (
  ...args: Parameters<IAgentSidecarRuntime['replanPlan']>
): Promise<Awaited<ReturnType<IAgentSidecarRuntime['replanPlan']>>> => {
  void args;
  throw new Error('Not implemented in test runtime.');
};

const createFakeRuntime = (
  overrides: Partial<IAgentSidecarRuntime> = {},
): IAgentSidecarRuntime => ({
  name: 'fake-runtime',
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

const createPlanRecordForTest = (
  overrides: Partial<TAgentPlanRecord> = {},
): TAgentPlanRecord => {
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

const createFakePlanStore = (
  record: TAgentPlanRecord = createPlanRecordForTest(),
): IAgentPlanStore => ({
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
});

const createPlanWorkflowStoreForTest = (): {
  cleanup: () => void;
  store: LibsqlAgentPlanWorkflowStore;
} => {
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
  const createStore = (): {
    cleanup: () => void;
    store: LibsqlAgentPlanStore;
  } => {
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
      assert.deepEqual(
        (await store.listPlanVersions(first.planId)).map((item) => item.version),
        [2, 1],
      );
    } finally {
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

      await assert.rejects(
        () => store.prepareExecution({
          planId: pending.planId,
          version: pending.version,
          stepId: 'step-1',
        }),
        /必须批准后才能执行/u,
      );

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
      assert.equal(
        (await store.finishPlan({
          planId: approved.planId,
          version: approved.version,
          status: 'completed',
        })).status,
        'completed',
      );
      await assert.rejects(
        () => store.rejectPlan({
          planId: approved.planId,
          version: approved.version,
          reason: '用户拒绝',
        }),
        /不能拒绝/u,
      );
    } finally {
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

      await assert.rejects(
        () => store.approvePlan({
          planId: pending.planId,
          version: pending.version + 1,
        }),
        /当前最新版本/u,
      );

      const approved = await store.approvePlan({
        planId: pending.planId,
        version: pending.version,
      });

      await assert.rejects(
        () => store.prepareExecution({
          planId: approved.planId,
          version: approved.version,
          stepId: 'missing-step',
        }),
        /不存在步骤/u,
      );

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

      await assert.rejects(
        () => store.prepareExecution({
          planId: rejectedPending.planId,
          version: rejectedPending.version,
          stepId: 'step-1',
        }),
        /必须批准后才能执行/u,
      );
    } finally {
      cleanup();
    }
  });
});

describe('LibSQL agent plan workflow store', () => {
  const createStore = (): {
    cleanup: () => void;
    store: LibsqlAgentPlanWorkflowStore;
  } => {
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
    } finally {
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
    } finally {
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
    } finally {
      cleanup();
    }
  });
});

const startServer = async (runtime: IAgentSidecarRuntime): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> => {
  const server = createAgentSidecarServer({ runtime });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
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

const parseNdjsonFrames = (body: string): unknown[] => body
  .trim()
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line));

const createTemporaryWorkspace = (): string => mkdtempSync(join(tmpdir(), 'mastra-workspace-'));

const toRecordForTest = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

type TExecutableToolForTest = {
  execute?: (inputData: unknown, context: unknown) => Promise<unknown> | unknown;
  toModelOutput?: (output: unknown) => unknown;
};

const getExecutableToolForTest = (
  tools: Record<string, unknown>,
  name: string,
): TExecutableToolForTest => {
  const tool = tools[name];

  assert.equal(Boolean(tool && typeof tool === 'object'), true);
  return tool as TExecutableToolForTest;
};

const readJsonModelOutputValueForTest = (value: unknown): Record<string, unknown> | null => {
  const output = toRecordForTest(value);

  assert.equal(output?.type, 'json');
  return toRecordForTest(output?.value);
};

const isRuntimeEventType = (event: unknown, type: string): boolean => {
  const record = toRecordForTest(event);
  const runtimeEvent = toRecordForTest(record?.event);

  return record?.type === 'agent_event' && runtimeEvent?.type === type;
};

const stripTokenBudgetEvents = <T>(events: readonly T[]): T[] =>
  events.filter((event) => !isRuntimeEventType(event, 'acontext.token.checked'));

const findTokenBudgetEvent = (events: readonly unknown[]): Record<string, unknown> | null => {
  const event = events.find((candidate) => isRuntimeEventType(candidate, 'acontext.token.checked'));
  const record = toRecordForTest(event);

  return toRecordForTest(record?.event);
};

const assertTokenBudgetEvent = (
  events: readonly unknown[],
  expected: {
    runId?: string;
    toolCount?: number;
    mcpToolCount?: number;
    mcpServerCount?: number;
    uiContextToolCount?: number;
    nativeToolCount?: number;
    logToolCount?: number;
    workspaceEnabled?: boolean;
    browserEnabled?: boolean;
    memoryEnabled?: boolean;
    maxSteps?: number;
    toolChoice?: 'auto' | 'none';
    toolLoadStrategy?: string;
  } = {},
): void => {
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
    const capturedBodies: unknown[] = [];
    let callCount = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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

      capturedBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

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
    } finally {
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
    const capturedBodies: unknown[] = [];

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

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
    } finally {
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
    const payloadStats: unknown[] = [];

    globalThis.fetch = (async (): Promise<Response> =>
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;

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
    } finally {
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
    const capturedBodies: unknown[] = [];
    let callCount = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      callCount += 1;

      if (callCount === 1) {
        const firstLine = 'data: {"choices":[{"delta":{"reasoning_content":"我需要';
        const secondLine = '查时间","tool_calls":[{"id":"call-2"},{"id":"call-1"}]}}]}\n';
        const doneLine = 'data: [DONE]\n';
        const body = new ReadableStream<Uint8Array>({
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

      capturedBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

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
    } finally {
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
    const capturedBodies: unknown[] = [];
    let callCount = 0;

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      callCount += 1;

      if (callCount === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              'data: {"choices":[{"delta":{"reasoning_content":"先调用工具。","tool_calls":[{"id":"call-cancel-1"}]}}]}\n\n',
            ));
          },
        });

        return new Response(body, {
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }

      capturedBodies.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' } }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

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
    } finally {
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
    assert.throws(() =>
      agentSidecarPlanRequestSchema.parse({
        goal: ' ',
        messages: [],
        context: [],
      }),
    );
    assert.throws(() =>
      agentSidecarExecuteRequestSchema.parse({
        goal: null,
        messages: [],
        context: [],
        planId: 'plan-1',
        planVersion: 1,
        planStepId: 'step-1',
      }),
    );
    assert.throws(() =>
      agentSidecarExecuteRequestSchema.parse({
        goal: 'run',
        messages: [],
        context: [],
      }),
    );
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
    } as NodeJS.ProcessEnv;
    const expectedStorageDirectory = join(appDataRoot, 'com.xiaojianc.Calamex', 'agent-sidecar');

    assert.equal(
      resolveMastraStorageDirectory(env, 'D:/workspace/my_desktop_app'),
      expectedStorageDirectory,
    );
    assert.equal(
      resolveMastraStorageUrl(env, 'D:/workspace/my_desktop_app'),
      pathToFileURL(join(expectedStorageDirectory, 'mastra.db')).href,
    );
  });

  it('does not auto-enable semantic recall from OPENAI_API_KEY alone', () => {
    assert.equal(resolveSemanticRecallEnabled({
      OPENAI_API_KEY: 'test-key',
    } as NodeJS.ProcessEnv), false);

    assert.equal(resolveSemanticRecallEnabled({
      AGENT_SIDECAR_MEMORY_EMBEDDER_MODEL: 'openai/text-embedding-3-small',
    } as NodeJS.ProcessEnv), true);
  });

  it('keeps memory replay small by default with a bounded override', () => {
    assert.equal(resolveMemoryLastMessages({} as NodeJS.ProcessEnv), 6);
    assert.equal(resolveMemoryLastMessages({
      AGENT_SIDECAR_MEMORY_LAST_MESSAGES: '12',
    } as NodeJS.ProcessEnv), 12);
    assert.equal(resolveMemoryLastMessages({
      AGENT_SIDECAR_MEMORY_LAST_MESSAGES: '200',
    } as NodeJS.ProcessEnv), 12);
    assert.equal(resolveMemoryLastMessages({
      AGENT_SIDECAR_MEMORY_LAST_MESSAGES: '1',
    } as NodeJS.ProcessEnv), 2);
  });

  it('keeps observational memory opt-in to avoid hidden background model calls', () => {
    assert.equal(resolveObservationalMemoryEnabled({} as NodeJS.ProcessEnv), false);

    assert.equal(resolveObservationalMemoryEnabled({
      AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL: '1',
    } as NodeJS.ProcessEnv), true);

    assert.equal(resolveObservationalMemoryBufferingEnabled({
      AGENT_SIDECAR_MEMORY_ENABLE_OBSERVATIONAL_BUFFERING: 'true',
    } as NodeJS.ProcessEnv), true);
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
    } finally {
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
      } finally {
        rmSync(anotherWorkspace, { recursive: true });
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true });
    }
  });

  it('uses explicit UI thread id as the Mastra memory thread', () => {
    const scope = createMastraMemoryScope({
      threadId: 'ui-thread-1',
    }, 'session-123');

    assert.equal(scope.thread, 'ui-thread-1');
    assert.equal(scope.resource, 'agent-sidecar:global');
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

describe('Mastra file primitive tools', () => {
  it('reads a bounded 1-indexed file window with navigation metadata', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'src', 'app.ts'),
        ['alpha', 'beta', 'gamma', 'delta'].join('\n'),
        'utf8',
      );

      const tools = createMastraFileTools(workspaceRoot);
      const readTool = getExecutableToolForTest(tools, 'read_file_window');

      if (!readTool.execute) {
        throw new Error('read_file_window execute 不可用。');
      }

      const result = toRecordForTest(await readTool.execute({
        path: 'src/app.ts',
        startLine: 2,
        limit: 2,
      }, {}));

      assert.notEqual(result, null);
      assert.equal(result?.path, 'src/app.ts');
      assert.equal(result?.totalLines, 4);
      assert.equal(result?.totalLinesKnown, true);
      assert.equal(result?.encoding, 'utf8');
      assert.equal(result?.startLine, 2);
      assert.equal(result?.endLine, 3);
      assert.equal(result?.truncated, true);
      assert.equal(result?.nextStartLine, 4);
      assert.match(String(result?.content), /2 \| beta/u);
      assert.match(String(result?.content), /3 \| gamma/u);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('preserves read_file_window content payload when projecting output to the model', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    const sentinel = 'READ_WINDOW_PAYLOAD_MUST_SURVIVE_MODEL_OUTPUT';

    try {
      mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'src', 'payload.ts'),
        Array.from({ length: 120 }, (_, index) => {
          if (index === 119) {
            return `export const marker = '${sentinel}';`;
          }

          return `export const value${index} = '${String(index).padStart(3, '0')}-abcdefghijklmnopqrstuvwxyz';`;
        }).join('\n'),
        'utf8',
      );

      const tools = createMastraFileTools(workspaceRoot);
      const readTool = getExecutableToolForTest(tools, 'read_file_window');

      if (!readTool.execute || !readTool.toModelOutput) {
        throw new Error('read_file_window execute/toModelOutput 不可用。');
      }

      const rawResult = await readTool.execute({
        path: 'src/payload.ts',
        startLine: 1,
        limit: 120,
      }, {});
      const rawRecord = toRecordForTest(rawResult);
      const modelRecord = readJsonModelOutputValueForTest(readTool.toModelOutput(rawResult));
      const modelSerialized = JSON.stringify(modelRecord) ?? '';

      assert.equal(rawRecord?.contentTruncated, false);
      assert.match(String(modelRecord?.content), new RegExp(sentinel, 'u'));
      assert.equal(modelRecord?.encoding, 'utf8');
      assert.equal(modelRecord?.startLine, 1);
      assert.equal(modelRecord?.endLine, 120);
      assert.doesNotMatch(modelSerialized, /modelOutputTruncated|内容已截断/u);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('does not full-scan large files just to report totalLines', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'src', 'large.log'),
        Array.from({ length: 40_000 }, (_, index) => `line-${index} abcdefghijklmnopqrstuvwxyz`).join('\n'),
        'utf8',
      );

      const tools = createMastraFileTools(workspaceRoot);
      const readTool = getExecutableToolForTest(tools, 'read_file_window');

      if (!readTool.execute) {
        throw new Error('read_file_window execute 不可用。');
      }

      const result = toRecordForTest(await readTool.execute({
        path: 'src/large.log',
        startLine: 1,
        limit: 2,
      }, {}));

      assert.equal(result?.totalLines, -1);
      assert.equal(result?.totalLinesKnown, false);
      assert.equal(result?.startLine, 1);
      assert.equal(result?.endLine, 2);
      assert.equal(result?.truncated, true);
      assert.equal(result?.nextStartLine, 3);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns structured errors instead of throwing for invalid file reads', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      const tools = createMastraFileTools(workspaceRoot);
      const readTool = getExecutableToolForTest(tools, 'read_file_window');

      if (!readTool.execute) {
        throw new Error('read_file_window execute 不可用。');
      }

      const result = toRecordForTest(await readTool.execute({
        path: '../outside.ts',
      }, {}));
      const error = toRecordForTest(result?.error);

      assert.equal(error?.code, 'INVALID_PATH');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects file reads through symlinks that resolve outside the workspace', async (context) => {
    const workspaceRoot = createTemporaryWorkspace();
    const outsideRoot = mkdtempSync(join(tmpdir(), 'mastra-outside-'));

    try {
      writeFileSync(join(outsideRoot, 'secret.txt'), 'secret', 'utf8');

      try {
        symlinkSync(
          outsideRoot,
          join(workspaceRoot, 'escape'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          && typeof error.code === 'string'
          ? error.code
          : null;

        if (code === 'EPERM' || code === 'EACCES') {
          context.skip('当前系统不允许创建 symlink/junction，跳过真实路径逃逸测试。');
          return;
        }

        throw error;
      }

      const tools = createMastraFileTools(workspaceRoot);
      const readTool = getExecutableToolForTest(tools, 'read_file_window');

      if (!readTool.execute) {
        throw new Error('read_file_window execute 不可用。');
      }

      const result = toRecordForTest(await readTool.execute({
        path: 'escape/secret.txt',
      }, {}));
      const error = toRecordForTest(result?.error);

      assert.equal(error?.code, 'INVALID_PATH');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('searches files with a global match cap and reports truncation', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      writeFileSync(join(workspaceRoot, 'a.txt'), ['foo one', 'bar', 'foo two'].join('\n'), 'utf8');
      writeFileSync(join(workspaceRoot, 'b.txt'), ['foo three', 'foo four'].join('\n'), 'utf8');

      const tools = createMastraFileTools(workspaceRoot);
      const grepTool = getExecutableToolForTest(tools, 'grep_in_files');

      if (!grepTool.execute) {
        throw new Error('grep_in_files execute 不可用。');
      }

      const result = toRecordForTest(await grepTool.execute({
        pattern: 'foo',
        paths: { include: ['**/*.txt'] },
        contextLines: 0,
        maxMatches: 2,
        maxFilesScanned: 20,
        caseSensitive: true,
      }, {}));

      assert.notEqual(result, null);
      assert.equal(result?.matchesReturned, 2);
      assert.equal(result?.totalMatches, -1);
      assert.equal(result?.truncated, true);
      assert.equal(toRecordForTest(result?.scanStats)?.filesScanned, 2);
      assert.equal(Array.isArray(result?.files), true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists directories with bounded entries and default heavy-folder exclusions', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
      mkdirSync(join(workspaceRoot, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'src', 'app.ts'), ['one', 'two'].join('\n'), 'utf8');
      writeFileSync(join(workspaceRoot, 'node_modules', 'pkg', 'ignored.js'), 'ignored', 'utf8');

      const tools = createMastraFileTools(workspaceRoot);
      const listTool = getExecutableToolForTest(tools, 'list_dir');

      if (!listTool.execute) {
        throw new Error('list_dir execute 不可用。');
      }

      const result = toRecordForTest(await listTool.execute({
        path: '.',
        recursive: true,
        maxEntries: 20,
      }, {}));
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      const paths = entries
        .map((entry) => toRecordForTest(entry)?.path)
        .filter((path): path is string => typeof path === 'string');
      const appEntry = entries
        .map((entry) => toRecordForTest(entry))
        .find((entry) => entry?.path === 'src/app.ts');

      assert.equal(paths.includes('src/app.ts'), true);
      assert.equal(paths.some((path) => path.includes('node_modules')), false);
      assert.equal(appEntry?.lines, 2);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('searches TypeScript and Vue script symbols without returning file payloads', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'src', 'app.ts'),
        [
          'export function loadUser() { return null; }',
          'export class UserStore {',
          '  refresh() { return loadUser(); }',
          '}',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(workspaceRoot, 'src', 'Panel.vue'),
        [
          '<template><div /></template>',
          '<script setup lang="ts">',
          'const panelTitle = "设置";',
          'function renderPanel() { return panelTitle; }',
          '</script>',
        ].join('\n'),
        'utf8',
      );

      const tools = createMastraFileTools(workspaceRoot);
      const symbolTool = getExecutableToolForTest(tools, 'search_symbols');

      if (!symbolTool.execute) {
        throw new Error('search_symbols execute 不可用。');
      }

      const result = toRecordForTest(await symbolTool.execute({
        query: 'panel',
        paths: { include: ['src/**/*'] },
        maxSymbols: 20,
        maxFilesScanned: 20,
      }, {}));
      const symbols = Array.isArray(result?.symbols) ? result.symbols.map(toRecordForTest) : [];

      assert.equal(result?.query, 'panel');
      assert.equal(symbols.some((symbol) => symbol?.name === 'panelTitle'), true);
      assert.equal(symbols.some((symbol) => symbol?.name === 'renderPanel'), true);
      assert.equal(symbols.some((symbol) => String(symbol?.preview).includes('<template>')), false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('searches Bash symbols through ast-grep dynamic language registration', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      mkdirSync(join(workspaceRoot, 'scripts'), { recursive: true });
      writeFileSync(
        join(workspaceRoot, 'scripts', 'deploy'),
        [
          '#!/usr/bin/env bash',
          'APP_ENV=production',
          'deploy_app() {',
          '  echo "$APP_ENV"',
          '}',
        ].join('\n'),
        'utf8',
      );

      const tools = createMastraFileTools(workspaceRoot);
      const symbolTool = getExecutableToolForTest(tools, 'search_symbols');

      if (!symbolTool.execute) {
        throw new Error('search_symbols execute 不可用。');
      }

      const result = toRecordForTest(await symbolTool.execute({
        query: 'deploy',
        paths: { include: ['scripts/*'] },
        maxSymbols: 20,
        maxFilesScanned: 20,
      }, {}));
      const symbols = Array.isArray(result?.symbols) ? result.symbols.map(toRecordForTest) : [];

      assert.equal(symbols.some((symbol) =>
        symbol?.name === 'deploy_app' &&
        symbol?.kind === 'function' &&
        symbol?.path === 'scripts/deploy'
      ), true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('exposes AED direct edit intent only in write profile', async () => {
    const workspaceRoot = createTemporaryWorkspace();

    try {
      mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
      const filePath = join(workspaceRoot, 'src', 'app.ts');
      writeFileSync(filePath, 'export const label = "old";', 'utf8');

      const readonlyTools = createMastraFileTools(workspaceRoot, 'readonly');
      const writeTools = createMastraFileTools(workspaceRoot, 'write');

      assert.equal(Object.keys(readonlyTools).includes('apply_file_edits'), false);
      assert.equal(Object.keys(writeTools).includes('apply_file_edits'), true);

      const patchTool = getExecutableToolForTest(writeTools, 'apply_file_edits');

      if (!patchTool.execute || !patchTool.toModelOutput) {
        throw new Error('apply_file_edits execute/toModelOutput 不可用。');
      }

      const rawResult = await patchTool.execute({
        path: 'src/app.ts',
        edits: [{
          oldString: '"old"',
          newString: '"new"',
        }],
        summary: '更新 label',
      }, {});
      const result = toRecordForTest(rawResult);
      const patch = toRecordForTest(result?.patch);
      const files = Array.isArray(patch?.files) ? patch.files.map(toRecordForTest) : [];
      const modelOutput = JSON.stringify(patchTool.toModelOutput(rawResult)) ?? '';

      assert.equal(result?.path, 'src/app.ts');
      assert.equal(result?.editCount, 1);
      assert.equal(result?.replacements, 1);
      assert.equal(result?.applied, true);
      assert.match(String(result?.beforeHash), /^fnv64:/u);
      assert.match(String(result?.afterHash), /^fnv64:/u);
      assert.equal(files[0]?.path, filePath);
      assert.equal(readFileSync(filePath, 'utf8'), 'export const label = "new";');
      assert.equal(modelOutput.includes('export const label'), false);
      assert.equal(modelOutput.includes('patchReady'), true);
      assert.equal(modelOutput.includes('"applied":true'), true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
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
    } finally {
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

    assert.equal(
      visibleText,
      '不过我可以帮你把它的内容清空（已经是空的），或者建议你手动执行：\n\n```bash\nRemove-Item .\\666.sh\n```',
    );
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
    assert.equal(createConfiguredRuntime({ AGENT_RUNTIME: 'mastra' }).name, 'mastra');

    assert.throws(
      () => resolveConfiguredRuntimeName({ AGENT_RUNTIME: 'legacy-runtime' }),
      /Unsupported AGENT_RUNTIME: legacy-runtime/u,
    );
  });
});

describe('Mastra runtime chat', () => {
  it('maps Mastra text chunks and keeps explicit thread context', async () => {
    let capturedMessages: unknown;
    let capturedStreamOptions: unknown;
    let capturedMcpOptions: unknown;
    let capturedModel: MastraModelConfig | null = null;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
    const streamedEvents: unknown[] = [];
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
    assert.equal((capturedModel as { provider?: unknown } | null)?.provider, 'deepseek');
    assert.equal((capturedModel as { modelId?: unknown } | null)?.modelId, 'deepseek-chat');
    assert.deepEqual(capturedMessages, [
      { role: 'assistant', content: '你好，我可以帮你做什么？' },
      { role: 'user', content: '请打招呼' },
    ]);
    assert.equal(capturedMcpOptions, undefined);
    const chatMemoryScope = createMastraMemoryScope({}, response.sessionId);
    assert.deepEqual(capturedStreamOptions, {
      abortSignal: abortController.signal,
      runId: 'req-123',
      maxSteps: 10,
      toolChoice: 'auto',
      memory: {
        thread: chatMemoryScope.thread,
        resource: chatMemoryScope.resource,
      },
    });
    assertTokenBudgetEvent(streamedEvents, {
      runId: 'req-123',
      toolCount: 6,
      mcpToolCount: 2,
      mcpServerCount: 0,
      uiContextToolCount: 0,
      nativeToolCount: 2,
      logToolCount: 2,
      workspaceEnabled: false,
      browserEnabled: false,
      memoryEnabled: true,
      maxSteps: 10,
      toolChoice: 'auto',
      toolLoadStrategy: 'gateway',
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
      createMcpClientBundle: async () => ({
        clients: [],
        configs: [],
        errors: [],
        tools: {},
        disconnectAll: async () => {},
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
    let capturedMessages: unknown;
    let capturedStreamOptions: unknown;
    let capturedAgentMemoryEnabled = false;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      now: () => '2026-05-03T00:00:00.000Z',
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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

  it('uses native file primitives instead of Mastra Workspace tools for workspace-backed chats', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    let capturedWorkspace: unknown;
    let capturedToolNames: string[] = [];
    let capturedStreamOptions: unknown;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
        capturedWorkspace = config.workspace;
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
      assert.equal(capturedWorkspace, undefined);
      assert.equal(capturedToolNames.includes('read_file_window'), true);
      assert.equal(capturedToolNames.includes('grep_in_files'), true);
      assert.equal(capturedToolNames.includes('list_dir'), true);
      assert.equal(capturedToolNames.includes('search_symbols'), true);
      assert.equal(capturedToolNames.includes('apply_file_edits'), true);
      assert.equal(capturedToolNames.includes('read_file'), false);
      assert.equal(capturedToolNames.includes('grep'), false);
      assert.equal(capturedToolNames.includes('lsp_inspect'), false);
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
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('uses native file primitives without exposing raw MCP tool schemas', async () => {
    const workspaceRoot = createTemporaryWorkspace();
    let capturedToolNames: string[] = [];
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
            throw new Error('generate should not be used in workspace filesystem MCP filter test');
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

      assert.equal(capturedToolNames.includes('read_text_file'), false);
      assert.equal(capturedToolNames.includes('probe_grep'), false);
      assert.equal(capturedToolNames.includes('probe_search_code'), false);
      assert.equal(capturedToolNames.includes('probe_extract_code'), false);
      assert.equal(capturedToolNames.includes('tavily_mcp_tavily_search'), false);
      assert.equal(capturedToolNames.includes('read_file_window'), true);
      assert.equal(capturedToolNames.includes('grep_in_files'), true);
      assert.equal(capturedToolNames.includes('list_dir'), true);
      assert.equal(capturedToolNames.includes('search_symbols'), true);
      assert.equal(capturedToolNames.includes('apply_file_edits'), false);
      assert.equal(capturedToolNames.includes('mcp_list_tools'), true);
      assert.equal(capturedToolNames.includes('mcp_call_tool'), true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps MCP access behind the gateway when no Mastra workspace is available', async () => {
    let capturedToolNames: string[] = [];
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
              type: 'reasoning',
              runId: 'run-reasoning',
              textDelta: 'The user wants the raw reasoning in the activity tree.',
            };
            yield {
              type: 'text-delta',
              runId: 'run-reasoning',
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
    const streamedEvents: unknown[] = [];
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
    const reasoningEvent = streamedEvents.find((event) =>
      isRuntimeEventType(event, 'agent.reasoning.delta'));

    assert.equal(typeof reasoningEvent, 'object');
    assert.notEqual(reasoningEvent, null);
    assert.equal((reasoningEvent as { type?: unknown }).type, 'agent_event');
    assert.equal(
      (reasoningEvent as { event?: { type?: unknown } }).event?.type,
      'agent.reasoning.delta',
    );
    assert.equal(
      (reasoningEvent as { event?: { text?: unknown } }).event?.text,
      'The user wants the raw reasoning in the activity tree.',
    );
    assert.deepEqual(streamedEvents.filter((event) =>
      (event as { type?: unknown }).type === 'message_delta'
    ), [
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
    const streamedEvents: unknown[] = [];

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
      const candidate = event as { type?: unknown; event?: { type?: unknown } };
      return candidate.type === 'agent_event'
        && (
          candidate.event?.type === 'agent.tool.started'
          || candidate.event?.type === 'agent.tool.completed'
        );
    });
    const startedEvent = runtimeToolEvents[0] as {
      event?: {
        type?: unknown;
        toolName?: unknown;
        toolUseId?: unknown;
        inputPreview?: unknown;
      };
    };
    const completedEvent = runtimeToolEvents[1] as {
      event?: {
        type?: unknown;
        toolName?: unknown;
        toolUseId?: unknown;
        resultPreview?: unknown;
        ok?: unknown;
      };
    };

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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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

    const result = await executeCurrentTime({}, {});

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

    const result = await executeCurrentTime({ input: {} }, {});

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

    const result = await executeCurrentTime({ input: { timezone: null } }, {});

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

    const rootNullResult = await executeCurrentTime({ timezone: null }, {});
    const argumentsNullResult = await executeCurrentTime({ arguments: { timezone: null } }, {});

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
    }, {});

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
    }, {});

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
    let capturedToolNames: string[] = [];
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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

  it('exposes read_current_file only when UI provides current-file tool context', async () => {
    let capturedToolNames: string[] = [];
    const capturedReadCurrentFileTool: {
      current: {
        execute?: (inputData: unknown, context: unknown) => Promise<unknown> | unknown;
        toModelOutput?: (output: unknown) => unknown;
      } | null;
    } = { current: null };
    const setCapturedReadCurrentFileTool = (tool: {
      execute?: (inputData: unknown, context: unknown) => Promise<unknown> | unknown;
      toModelOutput?: (output: unknown) => unknown;
    }): void => {
      capturedReadCurrentFileTool.current = tool;
    };
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
          setCapturedReadCurrentFileTool(readCurrentFileTool as {
            execute?: (inputData: unknown, context: unknown) => Promise<unknown> | unknown;
            toModelOutput?: (output: unknown) => unknown;
          });
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
    let capturedMessages: unknown;
    let capturedStreamOptions: unknown;
    let capturedToolNames: string[] = [];
    let disconnectCalls = 0;
    const executionRecord = createPlanRecordForTest();
    const workflowStore = createPlanWorkflowStoreForTest();
    const runtime = new MastraRuntime({
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
    const streamedEvents: unknown[] = [];

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
    const streamOptions = capturedStreamOptions as {
      runId?: unknown;
      maxSteps?: unknown;
      toolChoice?: unknown;
      requestContext?: unknown;
      memory?: {
        thread?: unknown;
        resource?: unknown;
      };
    };
    const executeMemoryScope = createMastraMemoryScope({ threadId: executionRecord.threadId }, response.sessionId);
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
            ? (streamedEvents[1] as { event: { id: string } }).event.id
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
            ? (streamedEvents[2] as { event: { id: string } }).event.id
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
            ? (streamedEvents[4] as { event: { id: string } }).event.id
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-v4-flash', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
            yield { type: 'reasoning-delta', payload: { reasoning: '我需要调用时间工具。' } };
            yield { type: 'text-delta', payload: { text: '今天是星期五。' } };
          })(),
          runId: 'test-run-id',
        }),
        generate: async () => ({ text: '' }),
      }),
    });
    const streamedEvents: unknown[] = [];

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

    const toRecordForTest = (value: unknown): Record<string, unknown> | null => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
    );
    const reasoningEvent = streamedEvents.find((event) =>
      toRecordForTest(event)?.type === 'agent_event'
      && toRecordForTest(toRecordForTest(event)?.event)?.type === 'agent.reasoning.delta');

    assert.ok(reasoningEvent !== undefined, 'reasoning event should be emitted');
    assert.equal(
      toRecordForTest(toRecordForTest(reasoningEvent)?.event)?.text,
      '我需要调用时间工具。',
    );
    assert.equal(response.result, '今天是星期五。');
    assert.equal(disconnectCalls, 0);
  });
});

describe('Mastra runtime approval resolution', () => {
  it('resumes a pending approval on the original agent instance while keeping the approval request id opaque to the client', async () => {
    let capturedApprovalOptions: unknown;
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
          approveToolCall: async (approvalOptions) => {
            capturedApprovalOptions = approvalOptions;

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

    const resumed = await runtime.resolveApproval({
      sessionId: initial.sessionId,
      requestId: approvalRequestId,
      decision: 'approved',
    });

    assert.deepEqual(capturedApprovalOptions, {
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

  it('keeps the existing approval tool_result plus done contract instead of returning a runtime-specific placeholder error', async () => {
    const runtime = new MastraRuntime({
      createAgent: () => {
        throw new Error('createAgent should not be used in Mastra approval test');
      },
      readModelConfig: () => null,
    });
    const streamedEvents: unknown[] = [];

    const response = await runtime.resolveApproval({
      sessionId: 'approval-session',
      requestId: 'approval-1',
      decision: 'approved',
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
          decision: 'approved',
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
    let capturedMessages: unknown;
    let capturedGenerateOptions: unknown;
    let capturedModel: MastraModelConfig | null = null;
    let capturedToolNames: string[] = [];
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
    const streamedEvents: unknown[] = [];

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
    assert.equal((capturedModel as { provider?: unknown } | null)?.provider, 'deepseek');
    assert.equal((capturedModel as { modelId?: unknown } | null)?.modelId, 'deepseek-chat');
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
    let capturedJsonPromptInjection: unknown;
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
    let capturedGenerateOptions: unknown;
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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

    assert.match(capturedInstructions, /Validator Agent/u);
    assert.deepEqual(capturedGenerateOptions, {
      runId: capturedGenerateOptions && typeof capturedGenerateOptions === 'object' && 'runId' in capturedGenerateOptions
        ? (capturedGenerateOptions as { runId: unknown }).runId
        : '',
      maxSteps: 8,
      toolChoice: 'auto',
      structuredOutput: {
        schema: agentPlanValidationReportSchema,
      },
      memory: {
        thread: createMastraMemoryScope({ threadId: executionRecord.threadId }, response.sessionId).thread,
        resource: createMastraMemoryScope({ threadId: executionRecord.threadId }, response.sessionId).resource,
      },
    });
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
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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
    let capturedRollbackOptions: unknown;
    let disconnectCalls = 0;
    const runtime = new MastraRuntime({
      now: () => '2026-05-03T01:00:00.000Z',
      readModelConfig: () => new ModelRouterLanguageModel({ providerId: 'deepseek', modelId: 'deepseek-chat', apiKey: 'test-key', url: 'https://example.com/v1' }),
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

    const rollbackOptions = capturedRollbackOptions as {
      step?: unknown;
      requestContext?: unknown;
    };
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
    let capturedInput: unknown;
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
    ] as const;
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
    } finally {
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
    } finally {
      await server.close();
    }
  });

  it('returns persisted plan records through POST and GET query routes', async () => {
    const record = createPlanRecordForTest({
      planId: 'plan-query-1',
      version: 2,
      status: 'approved',
    });
    const capturedInputs: unknown[] = [];
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
    } finally {
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
    } finally {
      await server.close();
    }
  });
});
