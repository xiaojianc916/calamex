import { createPinia, setActivePinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';

import { useAiAgentStore } from '@/store/aiAgent';
import type { IAiAgentRun, IAiTaskPlanStep } from '@/types/ai';

const createStep = (
  index: number,
  status: IAiTaskPlanStep['status'] = 'pending',
): IAiTaskPlanStep => ({
  id: `plan-step-${index + 1}`,
  index,
  title: index === 0 ? '收集上下文' : '执行修改',
  goal: index === 0 ? '收集上下文' : '执行修改',
  kind: index === 0 ? 'inspect' : 'edit',
  status,
  expectedOutput: index === 0 ? '上下文摘要' : '修改结果',
  tools: index === 0 ? ['read_current_file'] : ['propose_patch'],
  requiresUserApproval: false,
  riskLevel: 'low',
});

const createRun = (steps: IAiTaskPlanStep[]): IAiAgentRun => ({
  id: 'agent-run-1',
  goal: '实现计划模式持久化',
  status: 'running-step',
  steps,
  currentStepId: steps[0]?.id ?? null,
  createdAt: '2026-05-11T10:00:00.000Z',
  updatedAt: '2026-05-11T10:01:00.000Z',
  startedAt: '2026-05-11T10:00:00.000Z',
  completedAt: null,
  errorMessage: null,
});

const createPersistedPinia = () => {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({}).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

describe('aiAgent store step details', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('默认使用 agent 模式，并在刷新后恢复用户上次切换的模式', async () => {
    createPersistedPinia();
    const store = useAiAgentStore();

    expect(store.mode).toBe('agent');

    store.mode = 'plan';
    await nextTick();

    createPersistedPinia();
    const restored = useAiAgentStore();

    expect(restored.mode).toBe('plan');
  });

  it('默认执行模式为 interactive，并在刷新后恢复用户切换的自主模式', async () => {
    createPersistedPinia();
    const store = useAiAgentStore();

    expect(store.executionMode).toBe('interactive');

    store.setExecutionMode('autonomous');
    await nextTick();

    createPersistedPinia();
    const restored = useAiAgentStore();

    expect(restored.executionMode).toBe('autonomous');
  });

  it('保存 step 的 Web Sources 摘要与工具结果，不保存网页全文', () => {
    const store = useAiAgentStore();

    store.setStepWebSources('run-1', 'step-1', [
      {
        id: 'web-source-1',
        title: 'Tauri Docs',
        url: 'https://tauri.app/start/',
        sourceType: 'docs',
        status: 'fetched',
        queryPreview: 'Tauri docs',
        fetchedAt: '2026-04-29T10:00:00.000Z',
        textRef: 'web-text:abc',
        excerpt: '短摘要',
      },
    ]);
    store.appendStepToolResults('run-1', 'step-1', [
      {
        id: 'tool-result-1',
        runId: 'run-1',
        stepId: 'step-1',
        toolName: 'web_fetch',
        status: 'succeeded',
        summary: '读取 1 个网页正文引用',
        startedAt: '2026-04-29T10:00:00.000Z',
        endedAt: '2026-04-29T10:00:01.000Z',
        outputRef: 'web-text:abc',
      },
    ]);

    const detail = store.getStepDetail('run-1', 'step-1');

    expect(detail?.webSources[0]?.textRef).toBe('web-text:abc');
    expect(detail?.webSources[0]?.excerpt).toBe('短摘要');
    expect(detail?.toolResults[0]?.outputRef).toBe('web-text:abc');
    expect(JSON.stringify(detail)).not.toContain('<html');
  });

  it('保存 patch summary 统计与 ref，不保存完整 diff', () => {
    const store = useAiAgentStore();

    store.appendPatchSummary({
      id: 'patch-summary-1',
      runId: 'run-1',
      stepId: 'step-1',
      totalAdditions: 3,
      totalDeletions: 1,
      patchRef: 'patch:run-1:step-1',
      appliedAt: '2026-04-29T10:00:00.000Z',
      files: [
        {
          path: 'src/agent/runtime.ts',
          status: 'modified',
          additions: 3,
          deletions: 1,
          diffRef: 'diff:runtime',
          rollbackRef: 'rollback:runtime',
        },
      ],
    });

    const summaries = store.getPatchSummaries('run-1');

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.files[0]?.diffRef).toBe('diff:runtime');
    expect(JSON.stringify(summaries)).not.toContain("- const mode = 'chat'");
  });

  it('累计官方 usage 用于多步 Agent token 汇总，同时保留最近一次 usage', () => {
    const store = useAiAgentStore();

    store.setLatestOfficialUsage({
      inputTokens: 10,
      inputTokenDetails: {
        noCacheTokens: 8,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      },
      outputTokens: 5,
      outputTokenDetails: {
        textTokens: 3,
        reasoningTokens: 2,
      },
      totalTokens: 15,
      cachedInputTokens: 2,
      reasoningTokens: 2,
    });
    store.setLatestOfficialUsage({
      inputTokens: 20,
      inputTokenDetails: {
        noCacheTokens: 19,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
      },
      outputTokens: 7,
      outputTokenDetails: {
        textTokens: 6,
        reasoningTokens: 1,
      },
      totalTokens: 27,
      cachedInputTokens: 1,
      reasoningTokens: 1,
    });

    expect(store.latestOfficialUsage).toMatchObject({
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
    });
    expect(store.totalOfficialUsage).toMatchObject({
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
      cachedInputTokens: 3,
      reasoningTokens: 3,
    });
  });

  it('持久化计划快照并在刷新恢复时将运行中状态转为可继续的暂停态', async () => {
    createPersistedPinia();
    const store = useAiAgentStore();
    const steps = [createStep(0, 'running'), createStep(1)];

    store.setPlan('实现计划模式持久化', steps, {
      planId: 'plan-persist-1',
      threadId: 'thread-persist-1',
      version: 1,
      status: 'executing',
      approvedAt: '2026-05-11T10:00:00.000Z',
      executedAt: null,
      rejectionReason: null,
      errorMessage: null,
      summary: '恢复计划模式 UI',
      requiresApproval: true,
    });
    store.upsertRun(createRun(steps));
    await nextTick();

    createPersistedPinia();
    const restored = useAiAgentStore();

    expect(restored.planId).toBe('plan-persist-1');
    expect(restored.steps).toHaveLength(2);
    expect(restored.activeRun?.status).toBe('paused');
    expect(restored.activeRun?.currentStepId).toBe('plan-step-1');
    expect(restored.activeRun?.steps[0]?.status).toBe('pending');
    expect(restored.activeRun?.steps[0]?.isActive).toBe(false);
  });
});
