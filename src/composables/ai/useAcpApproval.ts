import { type ComputedRef, computed, onScopeDispose, ref } from 'vue';

import {
  buildAcpPermissionApproval,
  type IAcpPermissionRequest,
  type IBuildAcpPermissionApprovalOptions,
  type IToolConfirmationApproval,
} from '@/components/ai-elements/approval';
import { aiService } from '@/services/ipc/ai.service';
import type { IAcpPermissionRequestPayload } from '@/types/ai/acp-permission.schema';

/* ============================================================================
 * ACP 工具调用审批的前端闭环（ADR-20260617 D6）。
 *
 * 职责：订阅宝主经 `ai:sidecar-approval` 抹来的反向
 * `session/request_permission` 负载（监听半 6b-3a），排队去重后经
 * `buildAcpPermissionApproval` 归一到复用 `ApprovalPrompt` 的展示 VM；用户选择
 * 后经 `aiService.resolveAcpApproval`（发送半 6b-3b）回投 `optionId` 原文决策，
 * 唤醒被挂起的 JSON-RPC。
 *
 * 设计取舍（与已读源码一致，不自创）：
 * - 纯函数化、可在 effectScope 内单测，与驱动循环 / `.vue` 解耦；
 * - 队列 FIFO，`current` 单点呈现（镜像 Codex 审批浮层一次一个）；
 * - 同一 `toolCallId` 重发时原位替换（代理修订同一请求）；
 * - `decision` 是用户所选 `optionId` 原文，跨层不做语义解释（对齐
 *   `approval.rs` 「逐字 optionId 优先」匹配）；
 * - ACP 的 request_permission 负载不含问句，故标题/摘要/影响由上层通过
 *   `resolveContext` 按 `toolCallId` 关联已渲染的工具调用后注入。
 * ========================================================================== */

/** 一条待决的 ACP 审批（原始请求 + 已构建的展示 VM）。 */
export interface IPendingAcpApproval {
  sessionId: string;
  toolCallId: string;
  request: IAcpPermissionRequest;
  approval: IToolConfirmationApproval;
}

export interface IUseAcpApprovalOptions {
  /**
   * 按 `toolCallId` 关联已渲染工具调用后，为审批浮层注入标题/摘要/影响。
   * 缺省时 `buildAcpPermissionApproval` 使用通用回退标题。
   */
  resolveContext?: (request: IAcpPermissionRequest) => IBuildAcpPermissionApprovalOptions;
}

export interface IUseAcpApprovalReturn {
  /** 按到达顺序排列的全部待决审批（只读视图）。 */
  pending: ComputedRef<IPendingAcpApproval[]>;
  /** 当前应呈现的审批（队首），无则 null。 */
  current: ComputedRef<IPendingAcpApproval | null>;
  hasPending: ComputedRef<boolean>;
  /** 回投决策（`decision` = optionId 原文）并出队；失败时恢复待办并抛出。 */
  resolve: (toolCallId: string, decision: string) => Promise<void>;
  /** 不回投仅本地出队（例如回合已被外部取消）。 */
  dismiss: (toolCallId: string) => void;
}

export const useAcpApproval = (options: IUseAcpApprovalOptions = {}): IUseAcpApprovalReturn => {
  const queue = ref<IPendingAcpApproval[]>([]);

  const enqueue = (payload: IAcpPermissionRequestPayload): void => {
    // payload 与 IAcpPermissionRequest 结构一致（option.kind 两者为同一字面联合）。
    const request: IAcpPermissionRequest = payload;
    const entry: IPendingAcpApproval = {
      sessionId: payload.sessionId,
      toolCallId: payload.toolCallId,
      request,
      approval: buildAcpPermissionApproval(request, options.resolveContext?.(request)),
    };

    const existingIndex = queue.value.findIndex((item) => item.toolCallId === payload.toolCallId);
    if (existingIndex >= 0) {
      const next = queue.value.slice();
      next[existingIndex] = entry;
      queue.value = next;
      return;
    }
    queue.value = [...queue.value, entry];
  };

  const remove = (toolCallId: string): void => {
    queue.value = queue.value.filter((item) => item.toolCallId !== toolCallId);
  };

  const dismiss = (toolCallId: string): void => {
    remove(toolCallId);
  };

  const resolve = async (toolCallId: string, decision: string): Promise<void> => {
    const entry = queue.value.find((item) => item.toolCallId === toolCallId);
    if (!entry) {
      return;
    }

    // 乐观出队：避免重复点击；回投失败再恢复到队首。
    remove(toolCallId);
    try {
      await aiService.resolveAcpApproval({
        sessionId: entry.sessionId,
        toolCallId,
        decision,
      });
    } catch (error) {
      queue.value = [entry, ...queue.value.filter((item) => item.toolCallId !== toolCallId)];
      throw error;
    }
  };

  let unlisten: (() => void) | null = null;
  let disposed = false;

  void aiService
    .onAcpApproval((payload) => {
      enqueue(payload);
    })
    .then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
    })
    .catch(() => {
      // 订阅失败：审批浮层降级为不可用；回合仍可经 ai_cancel 取消，不致永久挂起。
    });

  onScopeDispose(() => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  });

  return {
    pending: computed(() => queue.value),
    current: computed(() => queue.value[0] ?? null),
    hasPending: computed(() => queue.value.length > 0),
    resolve,
    dismiss,
  };
};
