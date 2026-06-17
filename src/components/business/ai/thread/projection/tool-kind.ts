/**
 * runtime 工具大类 → 协议 ToolKind 的单一映射表(slice 5c 抽共享)。
 *
 * runtime 路径(from-runtime-tool-call)与 wire 路径(from-wire-tool-call)都需把
 * 项目的 `TAiRuntimeToolKind` 收敛到协议 VM 的 `TAiThreadToolKind`(对齐 Zed
 * `ToolKind`)。抽到此处作单一真源,避免两个兄弟适配器互相导入。
 *
 * 协议 VM 不持 toolName,图标最终由 kind 派生(见 tool-view),故 kind 是跨源
 * 统一的唯一语义键。
 */
import type { TAiRuntimeToolKind } from '@/constants/ai/runtime-tools';
import type { TAiThreadToolKind } from '@/types/ai/thread';

export const RUNTIME_KIND_TO_TOOL_KIND: Record<TAiRuntimeToolKind, TAiThreadToolKind> = {
  search: 'search',
  read: 'read',
  write: 'edit',
  git: 'other',
  browser: 'fetch',
  terminal: 'execute',
  task: 'other',
  network: 'fetch',
  diagram: 'other',
  symbol: 'search',
  python: 'execute',
  java: 'execute',
  memory: 'other',
  thinking: 'think',
  system: 'other',
};
