import type { StorageLike } from 'pinia-plugin-persistedstate';
import { z } from 'zod';

import {
  clearSessionSnapshot,
  readSessionSnapshot,
  writeSessionSnapshot,
} from '@/services/session/store';
import { SessionSnapshotSchema, type TSessionSnapshot } from '@/types/session';
import { logger } from '@/utils/platform/logger';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

const EDITOR_SESSION_KEY = 'shell-ide:editor';

/**
 * pinia-plugin-persistedstate 的 StorageLike 适配器,后端为 localStorage
 * (唯一权威,见 services/session/store)。
 *
 * getItem / setItem / removeItem 全部同步:localStorage 读写本身同步且廉价,不再需要
 * 异步 hydrate、超时占位、deferredWrite、对账或防抖——这些都是旧 Tauri-store 异步 IPC
 * 竞态的历史包袱,已随 localStorage 权威化一并移除。
 *
 * 在 plugin 契约之外额外暴露 removeItem,供业务层(登出 / 切换工作区 / 测试 reset)主动
 * 清理持久化快照。plugin 自身不会调用 removeItem。
 */
export interface ITauriSessionStorage extends StorageLike {
  removeItem(key: string): void;
}

const sessionLogger = logger.child({ scope: 'session' });

const PersistedEditorStoreSchema = z.object({
  sessionSnapshot: SessionSnapshotSchema,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const tauriSessionStorage: ITauriSessionStorage = {
  getItem(key) {
    if (key !== EDITOR_SESSION_KEY) {
      return null;
    }
    const snapshot = readSessionSnapshot();
    if (snapshot == null) {
      return null;
    }
    return JSON.stringify({ sessionSnapshot: snapshot });
  },

  setItem(key, value) {
    if (key !== EDITOR_SESSION_KEY) {
      return;
    }
    let snapshot: TSessionSnapshot;
    try {
      snapshot = PersistedEditorStoreSchema.parse(JSON.parse(value)).sessionSnapshot;
    } catch (error) {
      // schema 校验失败:不写盘。用户感知是 "改的东西没存",必须留痕。
      sessionLogger.warn({ event: 'snapshot-validation-failed', err: error });
      return;
    }
    try {
      writeSessionSnapshot(snapshot);
    } catch (error) {
      sessionLogger.warn({ event: 'snapshot-persist-failed', err: error });
    }
  },

  removeItem(key) {
    if (key !== EDITOR_SESSION_KEY) {
      return;
    }
    clearSessionSnapshot();
  },
};
