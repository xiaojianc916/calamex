import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { aiEditService } from '@/services/ipc/ai-edit.service';
import type {
  IAiEditAuthState,
  IAiEditListTimelineRequest,
  IAiEditSetAuthLevelRequest,
  IAiEditSetPinPayload,
  IAiEditSetPinRequest,
  IAiEditTimelineEntry,
  TAiEditAuthLevel,
} from '@/types/ai/edit';

type TAiEditStoreStatus = 'idle' | 'loading' | 'error';

/**
 * 哨兵 updatedAt: 表示 authState 尚未从后端拉取过。
 * 用 epoch 0 是为了让任何真实 timestamp 都更大,简化「需要刷新」判断。
 */
const createDefaultAuthState = (): IAiEditAuthState => ({
  level: 'manual',
  taskId: null,
  updatedAt: new Date(0).toISOString(),
});

export const useAiEditStore = defineStore('ai-edit', () => {
  // ── State ────────────────────────────────────────────────────────────────
  const authState = ref<IAiEditAuthState>(createDefaultAuthState());
  const timelineEntries = ref<IAiEditTimelineEntry[]>([]);
  const status = ref<TAiEditStoreStatus>('idle');
  const errorMessage = ref<string | null>(null);

  /**
   * Per-resource 单调写入序号,防止「先发后到」的旧响应覆盖新响应。
   * 同一资源的并发写入只保留 seq 最大的那次落盘。
   */
  let authWriteSeq = 0;
  let timelineWriteSeq = 0;

  /**
   * 状态机操作序号,确保最新一次 in-flight 操作的 status 转换才生效,
   * 避免「旧请求 reject 把新请求刚标的 loading 状态写成 error」。
   */
  let statusOpSeq = 0;

  // ── Getters ──────────────────────────────────────────────────────────────
  const authLevel = computed<TAiEditAuthLevel>(() => authState.value.level);

  // TODO: 当 TAiEditAuthLevel 增加新成员时,需要确认新成员属于「自动应用」还是
  // 「手动确认」语义,避免被默认归入 isAutoApplyEnabled === true。
  const isAutoApplyEnabled = computed<boolean>(() => authLevel.value !== 'manual');

  const hasTimelineEntries = computed<boolean>(() => timelineEntries.value.length > 0);

  const isLoading = computed<boolean>(() => status.value === 'loading');
  const isError = computed<boolean>(() => status.value === 'error');

  // ── Internal helpers ─────────────────────────────────────────────────────

  const setStatus = (nextStatus: TAiEditStoreStatus, message: string | null = null): void => {
    status.value = nextStatus;
    errorMessage.value = message;
  };

  /**
   * 把 loading → idle/error 的状态机包装抽出来,消除三个 action 的样板代码。
   * - 只有最新一次 in-flight 操作的 success/error 才会更新 status,
   *   防止并发场景下旧请求的回执覆盖新请求的状态。
   * - 异常按原样向上抛,由调用方决定 UI 处理。
   */
  const withStatus = async <T>(op: () => Promise<T>, fallbackErrorMessage: string): Promise<T> => {
    const seq = ++statusOpSeq;
    setStatus('loading');
    try {
      const result = await op();
      if (seq === statusOpSeq) {
        setStatus('idle');
      }
      return result;
    } catch (error) {
      if (seq === statusOpSeq) {
        setStatus('error', error instanceof Error ? error.message : fallbackErrorMessage);
      }
      throw error;
    }
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const loadAuthState = (): Promise<IAiEditAuthState> =>
    withStatus(async () => {
      const seq = ++authWriteSeq;
      const nextState = await aiEditService.getAuthLevel();
      if (seq === authWriteSeq) {
        authState.value = nextState;
      }
      return authState.value;
    }, '读取 AED 授权状态失败。');

  const setAuthLevel = (payload: IAiEditSetAuthLevelRequest): Promise<IAiEditAuthState> =>
    withStatus(async () => {
      const seq = ++authWriteSeq;
      const nextState = await aiEditService.setAuthLevel(payload);
      if (seq === authWriteSeq) {
        authState.value = nextState;
      }
      return authState.value;
    }, '设置 AED 授权状态失败。');

  const loadTimeline = (
    payload: IAiEditListTimelineRequest = {},
  ): Promise<IAiEditTimelineEntry[]> =>
    withStatus(async () => {
      const seq = ++timelineWriteSeq;
      const nextTimeline = await aiEditService.listTimeline(payload);
      if (seq === timelineWriteSeq) {
        timelineEntries.value = nextTimeline.entries;
      }
      return timelineEntries.value;
    }, '读取 AED 时间线失败。');

  const setPin = (payload: IAiEditSetPinRequest): Promise<IAiEditSetPinPayload> =>
    withStatus(async () => {
      const result = await aiEditService.setPin(payload);
      const matchId = (entry: IAiEditTimelineEntry): boolean => {
        const selfMatch = entry.data.id === result.targetId && entry.type === result.targetType;
        const taskMatch =
          'taskId' in entry.data &&
          entry.data.taskId === result.targetId &&
          result.targetType === 'task';
        return selfMatch || taskMatch;
      };
      timelineEntries.value = timelineEntries.value.map((entry) =>
        matchId(entry) ? { ...entry, data: { ...entry.data, pinned: result.pinned } } : entry,
      );
      return result;
    }, '更新 AED Pin 状态失败。');

  const clearTimeline = (): void => {
    timelineEntries.value = [];
  };

  /**
   * 把 store 重置为初始 state；用于退出登录 / 切换工作区等场景。
   * Pinia 的 setup store 不会自动提供 $reset,需手动归零。
   * 同时把所有 in-flight 序号归零,丢弃尚未落盘的旧响应。
   */
  const reset = (): void => {
    authState.value = createDefaultAuthState();
    timelineEntries.value = [];
    status.value = 'idle';
    errorMessage.value = null;
    authWriteSeq = 0;
    timelineWriteSeq = 0;
    statusOpSeq = 0;
  };

  return {
    // state
    authState,
    timelineEntries,
    status,
    errorMessage,
    // getters
    authLevel,
    isAutoApplyEnabled,
    hasTimelineEntries,
    isLoading,
    isError,
    // actions
    loadAuthState,
    setAuthLevel,
    loadTimeline,
    setPin,
    clearTimeline,
    setStatus,
    reset,
  };
});
