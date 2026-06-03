import type { ITauriService } from '@/types/tauri';
import { tauriContracts } from './tauri.contracts';
import { defineContractIpc, definePayloadIpc } from './tauri.ipc-factory';

const aiEditGetAuthLevelIpc = defineContractIpc(
  'ai_edit_get_auth_level',
  '读取 AED 授权等级',
  tauriContracts.aiEditGetAuthLevel,
  { audit: 'sensitive', idempotent: true },
);

const aiEditSetAuthLevelIpc = definePayloadIpc(
  'ai_edit_set_auth_level',
  '设置 AED 授权等级',
  tauriContracts.aiEditSetAuthLevel,
  { audit: 'sensitive', timeoutMs: 15_000 },
);

const aiEditListTimelineIpc = definePayloadIpc(
  'ai_edit_list_timeline',
  '读取 AED 时间线',
  tauriContracts.aiEditListTimeline,
  { audit: 'sensitive', timeoutMs: 15_000 },
);

const aiEditCreateSnapshotIpc = definePayloadIpc(
  'ai_edit_create_snapshot',
  '创建 AED 手动快照',
  tauriContracts.aiEditCreateSnapshot,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const aiEditSetPinIpc = definePayloadIpc(
  'ai_edit_set_pin',
  '更新 AED Pin 状态',
  tauriContracts.aiEditSetPin,
  { audit: 'sensitive', timeoutMs: 15_000 },
);

const aiEditGetDiffIpc = definePayloadIpc(
  'ai_edit_get_diff',
  '读取 AED 文件 diff',
  tauriContracts.aiEditGetDiff,
  { audit: 'sensitive', timeoutMs: 20_000 },
);

const aiEditRestoreSnapshotIpc = definePayloadIpc(
  'ai_edit_restore_snapshot',
  '恢复 AED 快照',
  tauriContracts.aiEditRestoreSnapshot,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditUndoOperationIpc = definePayloadIpc(
  'ai_edit_undo_operation',
  '撤销 AED 编辑',
  tauriContracts.aiEditUndoOperation,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditRevertFileIpc = definePayloadIpc(
  'ai_edit_revert_file',
  '回滚 AED 单文件',
  tauriContracts.aiEditRevertFile,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditRevertHunkIpc = definePayloadIpc(
  'ai_edit_revert_hunk',
  '回滚 AED 单个 hunk',
  tauriContracts.aiEditRevertHunk,
  { audit: 'sensitive', timeoutMs: 30_000 },
);

const aiEditRevertTaskIpc = definePayloadIpc(
  'ai_edit_revert_task',
  '回滚 AED 当前任务',
  tauriContracts.aiEditRevertTask,
  { audit: 'sensitive', timeoutMs: 30_000 },
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
  aiEditGetAuthLevel: () => aiEditGetAuthLevelIpc(undefined),

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
