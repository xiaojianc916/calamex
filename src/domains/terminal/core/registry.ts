/**
 * src/domains/terminal/core/registry.ts
 * useTerminalRegistryStore — 终端会话注册表（R-20.2.2）
 *
 * 通过 Pinia setup store 暴露，MUST NOT 使用裸模块级变量。
 * 负责 TerminalSession 的创建、查询、枚举和完整销毁。
 */

import { defineStore } from 'pinia';
import { markRaw, type Ref, ref } from 'vue';
import type { TTerminalConnectionState } from '@/types/terminal';
import { type ITerminalSessionOptions, TerminalSession } from './session';

/** registry 持有的 session 响应式状态 refs（与 session 生命周期解耦合） */
interface ISessionStatusRefs {
  status: Ref<TTerminalConnectionState>;
  statusMessage: Ref<string>;
}

/**
 * 终端会话注册表 store。
 * 使用 `markRaw` 包裹 Map 以防止 Vue 对 TerminalSession 类实例做深度代理。
 */
export const useTerminalRegistryStore = defineStore('terminal-registry', () => {
  // 使用 markRaw 确保 TerminalSession 实例不被 Vue reactive 系统深度代理（Fix-1）
  const _map = markRaw(new Map<string, TerminalSession>());
  // registry 持有的 status refs，确保 session 创建前后可以读同一对 ref（Fix-3）
  const _statusRefs = markRaw(new Map<string, ISessionStatusRefs>());

  const _getOrCreateStatusRefs = (id: string): ISessionStatusRefs => {
    const existing = _statusRefs.get(id);
    if (existing) return existing;
    const refs: ISessionStatusRefs = {
      status: ref<TTerminalConnectionState>('connecting'),
      statusMessage: ref('正在连接 WSL2 终端…'),
    };
    _statusRefs.set(id, refs);
    return refs;
  };

  /**
   * 获取指定 id 的会话；若不存在返回 null。
   */
  const get = (id: string): TerminalSession | null => _map.get(id) ?? null;

  /**
   * 注册一个新会话实例。若 id 已存在会覆盖旧引用（旧实例须在外部先 detach/dispose）。
   */
  const set = (id: string, session: TerminalSession): void => {
    _map.set(id, session);
  };

  /**
   * 枚举所有活跃会话（快照，非响应式）。
   */
  const list = (): TerminalSession[] => [..._map.values()];

  /**
   * 完全销毁指定会话：调用 session.dispose() 并从 Map 移除。
   */
  const dispose = async (id: string): Promise<void> => {
    const session = _map.get(id);
    if (!session) return;
    await session.dispose();
    _map.delete(id);
  };

  /**
   * 快捷工厂：创建 TerminalSession 并注册。若 id 已存在则直接返回现有会话。
   * session 实例用 markRaw() 包裹以防止 Vue 对 xterm/DOM 引用做深度代理（Fix-1）。
   * status/statusMessage 使用 registry 持有的共享 refs，使占位访问与实例同源（Fix-3）。
   */
  const getOrCreate = (options: ITerminalSessionOptions): TerminalSession => {
    const existing = _map.get(options.sessionId);
    if (existing) return existing;
    const { status: statusRef, statusMessage: statusMessageRef } = _getOrCreateStatusRefs(
      options.sessionId,
    );
    const session = markRaw(new TerminalSession({ ...options, statusRef, statusMessageRef }));
    _map.set(options.sessionId, session);
    return session;
  };

  /**
   * 获取指定 session 的响应式状态 refs（session 创建前可调用，永远指向同一对对象）。
   */
  const getStatusRefs = (id: string): ISessionStatusRefs => _getOrCreateStatusRefs(id);

  return { get, set, list, dispose, getOrCreate, getStatusRefs };
});
