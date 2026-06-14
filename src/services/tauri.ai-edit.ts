import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { runCommand, type ICommandMeta } from './tauri.ipc-define';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * AI 编辑（AED）invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 仪表化外壳改用声明式 metadata 表（AI_EDIT_COMMAND_META + runCommand），运行期行为与原
 *   手写 callSpectaCommand 逐字段一致：审计 / 超时 / 取消 / 错误归一化。
 */

/**
 * AED Tauri 命令的声明式包装元数据表。每条语义与原手写 callSpectaCommand 逐字段对齐，
 * 运行期行为不变；只是把重复的 option 字面量集中到一处便于审计。
 */
const AI_EDIT_COMMAND_META = {
  aiEditGetAuthLevel: {
    command: 'ai_edit_get_auth_level',
    guardHint: '读取 AED 授权等级',
    audit: 'sensitive',
    idempotent: true,
  },
  aiEditSetAuthLevel: {
    command: 'ai_edit_set_auth_level',
    guardHint: '设置 AED 授权等级',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  aiEditListTimeline: {
    command: 'ai_edit_list_timeline',
    guardHint: '读取 AED 时间线',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  aiEditCreateSnapshot: {
    command: 'ai_edit_create_snapshot',
    guardHint: '创建 AED 手动快照',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  aiEditSetPin: {
    command: 'ai_edit_set_pin',
    guardHint: '更新 AED Pin 状态',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  aiEditGetDiff: {
    command: 'ai_edit_get_diff',
    guardHint: '读取 AED 文件 diff',
    audit: 'sensitive',
    timeoutMs: 20_000,
  },
  aiEditRestoreSnapshot: {
    command: 'ai_edit_restore_snapshot',
    guardHint: '恢复 AED 快照',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  aiEditUndoOperation: {
    command: 'ai_edit_undo_operation',
    guardHint: '撤销 AED 编辑',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  aiEditRevertFile: {
    command: 'ai_edit_revert_file',
    guardHint: '回滚 AED 单文件',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  aiEditRevertHunk: {
    command: 'ai_edit_revert_hunk',
    guardHint: '回滚 AED 单个 hunk',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
  aiEditRevertTask: {
    command: 'ai_edit_revert_task',
    guardHint: '回滚 AED 当前任务',
    audit: 'sensitive',
    timeoutMs: 30_000,
  },
} satisfies Record<string, ICommandMeta>;

type TAiEditTauriService = Pick<
  ITauriService,
  | 'aiEditGetAuthLevel'
  | 'aiEditSetAuthLevel'
  | 'aiEditListTimeline'
  | 'aiEditCreateSnapshot'
  | 'aiEditSetPin'
  | 'aiEditGetDiff'
  | 'aiEditRestoreSnapshot'
  | 'aiEditUndoOperation'
  | 'aiEditRevertFile'
  | 'aiEditRevertHunk'
  | 'aiEditRevertTask'
>;

export const aiEditTauriService: TAiEditTauriService = {
  aiEditGetAuthLevel: () =>
    runCommand(AI_EDIT_COMMAND_META.aiEditGetAuthLevel, undefined, undefined, () =>
      commands.aiEditGetAuthLevel(),
    ),

  aiEditSetAuthLevel(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditSetAuthLevel, payload, options, () =>
      commands.aiEditSetAuthLevel(payload),
    );
  },

  aiEditListTimeline(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditListTimeline, payload, options, () =>
      commands.aiEditListTimeline(payload),
    );
  },

  aiEditCreateSnapshot(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditCreateSnapshot, payload, options, () =>
      commands.aiEditCreateSnapshot(payload),
    );
  },

  aiEditSetPin(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditSetPin, payload, options, () =>
      commands.aiEditSetPin(payload),
    );
  },

  aiEditGetDiff(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditGetDiff, payload, options, () =>
      commands.aiEditGetDiff(payload),
    );
  },

  aiEditRestoreSnapshot(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditRestoreSnapshot, payload, options, () =>
      commands.aiEditRestoreSnapshot(payload),
    );
  },

  aiEditUndoOperation(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditUndoOperation, payload, options, () =>
      commands.aiEditUndoOperation(payload),
    );
  },

  aiEditRevertFile(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditRevertFile, payload, options, () =>
      commands.aiEditRevertFile(payload),
    );
  },

  aiEditRevertHunk(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditRevertHunk, payload, options, () =>
      commands.aiEditRevertHunk(payload),
    );
  },

  aiEditRevertTask(payload, options?: IIpcCallOptions) {
    return runCommand(AI_EDIT_COMMAND_META.aiEditRevertTask, payload, options, () =>
      commands.aiEditRevertTask(payload),
    );
  },
};
