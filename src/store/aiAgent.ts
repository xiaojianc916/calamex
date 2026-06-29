import { defineStore } from 'pinia';
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
