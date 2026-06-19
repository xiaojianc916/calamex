import type { StorageLike } from 'pinia-plugin-persistedstate';
import { z } from 'zod/v3';

import { clearSession, loadSession, saveSession } from '@/services/session/store';
import { SessionSnapshotSchema, type TSessionSnapshot } from '@/types/session';
import { logger } from '@/utils/platform/logger';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const EDITOR_SESSION_KEY = 'shell-ide:editor';
const HYDRATE_TIMEOUT_MS = 300;
const SAVE_DEBOUNCE_MS = 500;
/**
 * 防抖最大等待:即使 setItem 持续高频触发(如连续编辑/滚动时 viewStates 频繁
 * 变化),也必须至少每 SAVE_MAX_WAIT_MS 落盘一次。否则 trailing-only 防抖会被
 * 持续活动"饿死",会话长时间不落盘,崩溃/退出即丢失这段窗口内的改动。
 */
const SAVE_MAX_WAIT_MS = 2000;

/**
 * Tauri 后端会话存储适配器,作为 pinia-plugin-persistedstate 的
 * StorageLike 实现。
 *
 * 在 plugin 契约之外额外暴露 removeItem,供业务层 (登出 / 切换工作区 /
 * 测试 reset) 主动清理持久化快照。**plugin 自身不会调用 removeItem。**
 *
 * 数据安全约束(关键):hydrate 读后端超时时**绝不能**用空白初始态覆盖磁盘上
 * 尚未读出的会话快照。详见 hydrateSessionStorage / reconcileAfterHydrate /
 * setItem 的 deferred-write 逻辑。
 */
export interface ITauriSessionStorage extends StorageLike {
  removeItem(key: string): void;
}

/** 加载状态,便于调用方区分 "用户无快照" 与 "IO 超时被迫放弃"。 */
export type THydrateStatus = 'loaded' | 'empty' | 'timeout';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let cache: TSessionSnapshot | null = null;
let isReady = false;
/**
 * 真正的后端读取是否已 settle。
 * - hydrate 命中/为空:settle 后置 true。
 * - hydrate 超时:先返回 'timeout' 但保持 false,直到后台读取真正 settle
 *   (reconcileAfterHydrate)才置 true。
 * 在其为 false 期间,setItem 不直接落盘,而是把最新值暂存到 deferredWrite,
 * 杜绝"超时空态覆盖磁盘快照"。
 */
let hydrationSettled = false;
/** 超时占位期间用户写入的最新值;reconcile 时据此决定落盘还是恢复磁盘值。 */
let deferredWrite: TSessionSnapshot | null = null;
/** 是否发生过 removeItem(显式清理);若有则后台对账不得复活磁盘数据。 */
let clearedDuringHydration = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前防抖批次首次入队的时间戳(ms);用于 SAVE_MAX_WAIT_MS 上限计算。 */
let firstPendingAt: number | null = null;
let persistQueue: Promise<void> = Promise.resolve();
let flushListenersRegistered = false;

const PersistedEditorStoreSchema = z.object({
  sessionSnapshot: SessionSnapshotSchema,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Promise.race 风格的超时;超时返回 sentinel,不抛错。 */
const TIMEOUT_SENTINEL: unique symbol = Symbol('hydrate-timeout');

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT_SENTINEL> =>
  new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT_SENTINEL);
    }, timeoutMs);
    promise
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(TIMEOUT_SENTINEL);
      });
  });

const sessionLogger = logger.child({ scope: 'session' });

const enqueuePersistOperation = (operation: () => Promise<void>, errorEvent: string): void => {
  persistQueue = persistQueue
    .catch(() => undefined)
    .then(operation)
    .catch((error) => {
      sessionLogger.error({ event: errorEvent, err: error });
    });
};

const clearSaveTimer = (): void => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
};

const schedulePersist = (value: TSessionSnapshot): void => {
  const now = Date.now();
  if (firstPendingAt === null) {
    firstPendingAt = now;
  }
  // trailing 防抖 + maxWait 上限:连续高频写入时,delay 随距首次入队的时间
  // 收敛到 0,保证最迟 SAVE_MAX_WAIT_MS 内必落盘一次。
  const elapsed = now - firstPendingAt;
  const delay = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS - elapsed));
  clearSaveTimer();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    firstPendingAt = null;
    enqueuePersistOperation(() => saveSession(value), 'snapshot-save-failed');
  }, delay);
};

/** best-effort:页面隐藏/卸载时把未落盘的最新 cache 立即入队写入。 */
const flushPendingPersist = (): void => {
  if (saveTimer === null || cache === null) return;
  clearSaveTimer();
  firstPendingAt = null;
  const value = cache;
  enqueuePersistOperation(() => saveSession(value), 'snapshot-flush-failed');
};

const registerFlushListeners = (): void => {
  if (flushListenersRegistered || typeof window === 'undefined') return;
  flushListenersRegistered = true;
  window.addEventListener('pagehide', flushPendingPersist);
  window.addEventListener('beforeunload', flushPendingPersist);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushPendingPersist();
      }
    });
  }
};

/**
 * 后台读取真正 settle 后的对账,仅由"第一个 settle 者"执行一次
 * (hydrationSettled 守卫)。
 *
 * - 占位期间已 removeItem(clearedDuringHydration):保持已清空状态,不复活。
 * - 占位期间用户已写入(deferredWrite 非空):用户值权威并落盘。
 * - 占位期间无写入:把磁盘真实值恢复进 cache(供后续 getItem),纯读取不落盘。
 */
const reconcileAfterHydrate = (loaded: TSessionSnapshot | null): void => {
  if (hydrationSettled) {
    return;
  }
  hydrationSettled = true;
  if (clearedDuringHydration) {
    return;
  }
  if (deferredWrite !== null) {
    const value = deferredWrite;
    deferredWrite = null;
    cache = value;
    schedulePersist(value);
    return;
  }
  cache = loaded;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 异步初始化:从 Tauri 后端加载快照到 cache,然后置 isReady。
 * 必须在 Pinia 读 getItem 之前 await 完成,否则前 300ms 内的读会
 * 拿到 null (Pinia 退化到 store 初始值)。
 *
 * 超时分支不再丢弃后台读取结果:loadSession 仍在后台运行,settle 后由
 * reconcileAfterHydrate 决定恢复磁盘数据还是落盘用户新值,从而避免
 * "后端偏慢一次 → 会话被空态覆盖"的静默数据丢失。
 *
 * 返回值用于调用方上报 / debug:
 * - 'loaded':成功拿到非空快照
 * - 'empty':成功但无快照 (首次启动)
 * - 'timeout':IO 在 HYDRATE_TIMEOUT_MS 内未返回,被迫以空态启动
 */
export const hydrateSessionStorage = async (): Promise<THydrateStatus> => {
  registerFlushListeners();
  const loadPromise = loadSession();
  // 后台对账:无论是否在 timeout 窗口内返回,真正 settle 后都对账一次。
  void loadPromise.then(reconcileAfterHydrate).catch((error) => {
    hydrationSettled = true;
    sessionLogger.error({ event: 'snapshot-hydrate-reconcile-failed', err: error });
  });
  const result = await withTimeout(loadPromise, HYDRATE_TIMEOUT_MS);
  isReady = true;
  if (result === TIMEOUT_SENTINEL) {
    // 占位空态:getItem 暂时返回 null,但 setItem 会 defer,最终处置交给
    // reconcileAfterHydrate,绝不在此用空态覆盖磁盘快照。
    cache = null;
    sessionLogger.warn({
      event: 'snapshot-hydrate-timeout',
      detail: `loadSession did not resolve within ${HYDRATE_TIMEOUT_MS}ms; deferring writes until settle`,
    });
    return 'timeout';
  }
  // 命中:reconcileAfterHydrate 通常已先行设置 cache,这里再确保一次。
  cache = result;
  return result == null ? 'empty' : 'loaded';
};

export const tauriSessionStorage: ITauriSessionStorage = {
  getItem(key) {
    if (!isReady || key !== EDITOR_SESSION_KEY || cache == null) {
      return null;
    }
    return JSON.stringify({
      sessionSnapshot: cache,
    });
  },

  setItem(key, value) {
    if (key !== EDITOR_SESSION_KEY) {
      return;
    }
    let snapshot: TSessionSnapshot;
    try {
      snapshot = PersistedEditorStoreSchema.parse(JSON.parse(value)).sessionSnapshot;
    } catch (error) {
      // schema 校验失败:既不写盘也不更新 cache。这是安全选择
      // (避免写入坏数据),但用户感知是 "改的东西没存"——必须留痕。
      sessionLogger.warn({ event: 'snapshot-validation-failed', err: error });
      return;
    }
    cache = snapshot;
    if (!hydrationSettled) {
      // hydrate(超时)尚未真正 settle:暂存最新值,等 reconcileAfterHydrate
      // 处置,避免用空白初始态覆盖磁盘上尚未读出的快照。
      deferredWrite = snapshot;
      return;
    }
    schedulePersist(snapshot);
  },

  removeItem(key) {
    if (key !== EDITOR_SESSION_KEY) {
      return;
    }
    clearSaveTimer();
    firstPendingAt = null;
    cache = null;
    deferredWrite = null;
    // 阻止后台对账把已删数据复活。
    clearedDuringHydration = true;
    hydrationSettled = true;
    enqueuePersistOperation(clearSession, 'snapshot-clear-failed');
  },
};
