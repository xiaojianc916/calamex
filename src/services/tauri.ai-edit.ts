import { commands } from '@/bindings/tauri';
import type { ITauriService } from '@/types/tauri';
import { callSpectaCommand } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * AI 编辑（AED）invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 仍保留薄仪表化外壳（callSpectaCommand：审计 / 超时 / 取消 / 错误归一化）。
 */

type TAiEditRequest<K extends keyof ITauriService> = Parameters<ITauriService[K]>[0];
type TAiEditResult<K extends keyof ITauriService> = Awaited<ReturnType<ITauriService[K]>>;

const aiEditGetAuthLevelIpc = (
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditGetAuthLevel'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_get_auth_level',
      guardHint: '读取 AED 授权等级',
      audit: 'sensitive',
      idempotent: true,
      signal: options?.signal,
    },
    () => commands.aiEditGetAuthLevel(),
  );

const aiEditSetAuthLevelIpc = (
  payload: TAiEditRequest<'aiEditSetAuthLevel'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditSetAuthLevel'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_set_auth_level',
      guardHint: '设置 AED 授权等级',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditSetAuthLevel(payload),
  );

const aiEditListTimelineIpc = (
  payload: TAiEditRequest<'aiEditListTimeline'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditListTimeline'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_list_timeline',
      guardHint: '读取 AED 时间线',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditListTimeline(payload),
  );

const aiEditCreateSnapshotIpc = (
  payload: TAiEditRequest<'aiEditCreateSnapshot'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditCreateSnapshot'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_create_snapshot',
      guardHint: '创建 AED 手动快照',
      audit: 'sensitive',
      timeoutMs: 20_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditCreateSnapshot(payload),
  );

const aiEditSetPinIpc = (
  payload: TAiEditRequest<'aiEditSetPin'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditSetPin'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_set_pin',
      guardHint: '更新 AED Pin 状态',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditSetPin(payload),
  );

const aiEditGetDiffIpc = (
  payload: TAiEditRequest<'aiEditGetDiff'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditGetDiff'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_get_diff',
      guardHint: '读取 AED 文件 diff',
      audit: 'sensitive',
      timeoutMs: 20_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditGetDiff(payload),
  );

const aiEditRestoreSnapshotIpc = (
  payload: TAiEditRequest<'aiEditRestoreSnapshot'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditRestoreSnapshot'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_restore_snapshot',
      guardHint: '恢复 AED 快照',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditRestoreSnapshot(payload),
  );

const aiEditUndoOperationIpc = (
  payload: TAiEditRequest<'aiEditUndoOperation'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditUndoOperation'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_undo_operation',
      guardHint: '撤销 AED 编辑',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditUndoOperation(payload),
  );

const aiEditRevertFileIpc = (
  payload: TAiEditRequest<'aiEditRevertFile'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditRevertFile'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_revert_file',
      guardHint: '回滚 AED 单文件',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditRevertFile(payload),
  );

const aiEditRevertHunkIpc = (
  payload: TAiEditRequest<'aiEditRevertHunk'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditRevertHunk'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_revert_hunk',
      guardHint: '回滚 AED 单个 hunk',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditRevertHunk(payload),
  );

const aiEditRevertTaskIpc = (
  payload: TAiEditRequest<'aiEditRevertTask'>,
  options?: IIpcCallOptions,
): Promise<TAiEditResult<'aiEditRevertTask'>> =>
  callSpectaCommand(
    {
      command: 'ai_edit_revert_task',
      guardHint: '回滚 AED 当前任务',
      audit: 'sensitive',
      timeoutMs: 30_000,
      input: payload,
      signal: options?.signal,
    },
    () => commands.aiEditRevertTask(payload),
  );

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
  aiEditGetAuthLevel: () => aiEditGetAuthLevelIpc(),

  aiEditSetAuthLevel: aiEditSetAuthLevelIpc,

  aiEditListTimeline: aiEditListTimelineIpc,

  aiEditCreateSnapshot: aiEditCreateSnapshotIpc,

  aiEditSetPin: aiEditSetPinIpc,

  aiEditGetDiff: aiEditGetDiffIpc,

  aiEditRestoreSnapshot: aiEditRestoreSnapshotIpc,

  aiEditUndoOperation: aiEditUndoOperationIpc,

  aiEditRevertFile: aiEditRevertFileIpc,

  aiEditRevertHunk: aiEditRevertHunkIpc,

  aiEditRevertTask: aiEditRevertTaskIpc,
};
