// d1s4d-store-trim.mjs
// D1 Slice 4-D：store/aiAgent.ts 裁剪为 ACP-native lean 形态 + 同步裁其单测。
//
// 依据：plan/run 脚手架的写入方（useAiAgentPlan.ts / useAiAgentRun.ts）已随 d1s1 删除，
// 唯一读取方（AiAssistantPanel 旧 plan/run 派生）已随 d1s3 重写移除；useAiAssistant 仅用
// mode/HITL 三门，useAiAgentNetwork 仅用 network/execution/errorMessage，useAcpUsage/useAcpPlan
// 完全不碰本 store。故 steps/classification/plan*/runs/activeRun/*OfficialUsage*/stepDetails/
// stepFinalAnswers/patchSummaries/toolActivities 及其全部 action/getter/helper + persist pick +
// hydrate/usage 块均为纯死代码 → 整文件重写删除（删除占比 ~70%，重写比锚点更干净）。
//
// 删除占比高，采用整文件覆盖。EOL 健壮：先把内嵌内容归一到 LF，再按目标文件现有 EOL 落盘
// （本仓本地为 CRLF），无论本脚本自身以何种换行保存都不会产生 \r\r\n。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ROOT = process.cwd();

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const toLf = (text) => text.replace(/\r\n/g, '\n');
const fromLf = (text, eol) => (eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

const rewrite = (rel, rawContent) => {
  const abs = `${ROOT}/${rel}`;
  if (!existsSync(abs)) {
    throw new Error(`目标不存在，请确认在仓库根目录运行：${rel}`);
  }
  const eol = detectEol(readFileSync(abs, 'utf8'));
  writeFileSync(abs, fromLf(toLf(rawContent), eol));
  console.log(`✓ rewrote ${rel} (eol=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
};

// ───────────────────────────────────────────────────────────────────────────
// src/store/aiAgent.ts —— lean ACP-native 形态
// ───────────────────────────────────────────────────────────────────────────
const STORE_TS = `import { defineStore } from 'pinia';
import { ref } from 'vue';
import { z } from 'zod';
import type { IAgentSidecarPendingAskUser } from '@/composables/ai/sidecar-ask-user';
import type {
  IAiContextReference,
  IAiToolConfirmationRequest,
  TAiAgentNetworkPermission,
} from '@/types/ai';
import {
  aiAgentNetworkPermissionSchema,
  aiToolConfirmationRequestSchema,
} from '@/types/ai/agent.schema';
import { AI_ASSISTANT_MODES, type TAiAssistantMode } from '@/types/ai/assistant-mode';
import { aiContextReferenceSchema } from '@/types/ai/context.schema';
import {
  AI_EXECUTION_MODE_DEFAULT,
  AI_EXECUTION_MODES,
  type TAiExecutionMode,
} from '@/types/ai/execution-mode';
import { askUserQuestionSchema } from '@/types/ai/sidecar.schema';
import { aiThreadEntrySchema, type IAiThreadEntry } from '@/types/ai/thread';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IAiPersistedSidecarAgentSession {
  sessionId: string;
  assistantMessageId: string;
  threadId: string | null;
  turnId: string | null;
  baseEntries: IAiThreadEntry[];
  messageContent: string;
  references: IAiContextReference[];
}

export type TAiAgentPanelMode = TAiAssistantMode;

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

const aiAgentPanelModeSchema = z.enum(AI_ASSISTANT_MODES);
const aiExecutionModeSchema = z.enum(AI_EXECUTION_MODES);

// 续聊 / 审批 resume 的基线上下文：权威 entries 快照。default([]) 兼容尚未写入该字段的旧持久化。
const aiPersistedSidecarAgentSessionSchema = z.object({
  sessionId: z.string().min(1),
  assistantMessageId: z.string().min(1),
  threadId: z.string().min(1).nullable(),
  turnId: z.string().min(1).nullable(),
  baseEntries: z.array(aiThreadEntrySchema).max(200).default([]),
  messageContent: z.string(),
  references: z.array(aiContextReferenceSchema).max(20),
});

// ask_user 反向提问的待作答门，复用共享 askUserQuestionSchema（单一来源），requestId 用于 resume。
const agentSidecarPendingAskUserSchema = z.object({
  requestId: z.string().min(1),
  questions: z.array(askUserQuestionSchema).min(1).max(4),
});

const aiAgentPersistSchema = z.object({
  mode: aiAgentPanelModeSchema,
  networkPermission: aiAgentNetworkPermissionSchema,
  // 执行自主性：interactive（默认，逐步门控）/ autonomous（自主执行）。default(...) 兼容旧持久化。
  executionMode: aiExecutionModeSchema.default(AI_EXECUTION_MODE_DEFAULT),
  pendingToolConfirmation: aiToolConfirmationRequestSchema.nullable(),
  // default(null) 兼容尚未写入该字段的旧持久化。
  pendingUserQuestion: agentSidecarPendingAskUserSchema.nullable().default(null),
  pendingSidecarAgentSession: aiPersistedSidecarAgentSessionSchema.nullable(),
  errorMessage: z.string(),
});

type TAiAgentPersistState = z.infer<typeof aiAgentPersistSchema>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAiAgentStore = defineStore(
  'ai-agent',
  () => {
    // -- State --------------------------------
    const mode = ref<TAiAgentPanelMode>('agent');
    const networkPermission = ref<TAiAgentNetworkPermission>('ask');
    const executionMode = ref<TAiExecutionMode>(AI_EXECUTION_MODE_DEFAULT);
    // HITL 三门（互斥占用同一回合）：工具审批 / 反向提问 / 二者共用的 resume session。
    const pendingToolConfirmation = ref<IAiToolConfirmationRequest | null>(null);
    const pendingUserQuestion = ref<IAgentSidecarPendingAskUser | null>(null);
    const pendingSidecarAgentSession = ref<IAiPersistedSidecarAgentSession | null>(null);
    const errorMessage = ref<string>('');

    // -- Actions ------------------------------
    const setMode = (nextMode: TAiAgentPanelMode): void => {
      mode.value = nextMode;
    };

    const setNetworkPermission = (permission: TAiAgentNetworkPermission): void => {
      networkPermission.value = permission;
    };

    const setExecutionMode = (next: TAiExecutionMode): void => {
      executionMode.value = next;
    };

    const setPendingToolConfirmation = (confirmation: IAiToolConfirmationRequest): void => {
      pendingToolConfirmation.value = confirmation;
    };

    const clearPendingToolConfirmation = (confirmationId?: string): void => {
      if (!confirmationId || pendingToolConfirmation.value?.id === confirmationId) {
        pendingToolConfirmation.value = null;
        pendingSidecarAgentSession.value = null;
      }
    };

    // ask_user 反向提问门，镜像 pendingToolConfirmation：clear 时连带回收共用的 resume session。
    const setPendingUserQuestion = (question: IAgentSidecarPendingAskUser): void => {
      pendingUserQuestion.value = question;
    };

    const clearPendingUserQuestion = (requestId?: string): void => {
      if (!requestId || pendingUserQuestion.value?.requestId === requestId) {
        pendingUserQuestion.value = null;
        pendingSidecarAgentSession.value = null;
      }
    };

    const setPendingSidecarAgentSession = (session: IAiPersistedSidecarAgentSession): void => {
      pendingSidecarAgentSession.value = session;
    };

    const clearPendingSidecarAgentSession = (): void => {
      pendingSidecarAgentSession.value = null;
    };

    return {
      // state
      mode,
      networkPermission,
      executionMode,
      pendingToolConfirmation,
      pendingUserQuestion,
      pendingSidecarAgentSession,
      errorMessage,
      // actions
      setMode,
      setNetworkPermission,
      setExecutionMode,
      setPendingToolConfirmation,
      clearPendingToolConfirmation,
      setPendingUserQuestion,
      clearPendingUserQuestion,
      setPendingSidecarAgentSession,
      clearPendingSidecarAgentSession,
    };
  },
  {
    persist: {
      key: 'shell-ide.ai-agent',
      pick: [
        'mode',
        'networkPermission',
        'executionMode',
        'pendingToolConfirmation',
        'pendingUserQuestion',
        'pendingSidecarAgentSession',
        'errorMessage',
      ],
      afterHydrate(ctx) {
        const store = ctx.store as unknown as TAiAgentPersistState;
        // store 上额外挂的 method 在 z.object 默认 strip 下被忽略，可直接整体解析。
        const parsed = aiAgentPersistSchema.safeParse(store);
        if (!parsed.success) {
          return;
        }
        // 没有待确认工具、也没有待作答提问时，顺手清掉残留 resume session（两门共用）。
        Object.assign(store, {
          ...parsed.data,
          pendingSidecarAgentSession:
            parsed.data.pendingToolConfirmation || parsed.data.pendingUserQuestion
              ? parsed.data.pendingSidecarAgentSession
              : null,
        });
      },
    },
  },
);
`;

// ───────────────────────────────────────────────────────────────────────────
// src/store/aiAgent.store.spec.ts —— 仅保留 mode / executionMode 持久化用例
// ───────────────────────────────────────────────────────────────────────────
const SPEC_TS = `import { createPinia, setActivePinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, nextTick } from 'vue';

import { useAiAgentStore } from '@/store/aiAgent';

const createPersistedPinia = () => {
  const pinia = createPinia();
  pinia.use(piniaPluginPersistedstate);
  createApp({}).use(pinia);
  setActivePinia(pinia);
  return pinia;
};

describe('aiAgent store persistence', () => {
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
});
`;

rewrite('src/store/aiAgent.ts', STORE_TS);
rewrite('src/store/aiAgent.store.spec.ts', SPEC_TS);
console.log('done: aiAgent store trimmed to ACP-native lean form');