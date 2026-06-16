import { buildAiAedDiffRef } from '@/components/business/ai/edit/diff-ref';
import type { IAiApplyPatchPayload, IAiPatchFile, IAiPatchSet } from '@/types/ai';
import type { IAiEditGetDiffPayload, TAiEditOperationKind } from '@/types/ai/edit';
import type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  TAiAgentChangedFileStatus,
} from '@/types/ai/patch';
import { fnv1a32Base36 } from '@/utils/core/hash';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/file/path';

const AED_PATCH_REF_PREFIX = 'aed-patch:';
const PATCH_SUMMARY_ID_PREFIX = 'patch-summary';

export interface IAiPatchFileLineStats {
  additions: number;
  deletions: number;
}

export interface IBuildAiAgentPatchSummaryInput {
  patch: IAiPatchSet;
  applyResult: IAiApplyPatchPayload;
  taskId: string;
  runId: string;
  stepId: string;
  appliedAt: string;
}

export interface IBuildAiAgentPatchSummaryFromDiffsInput {
  diffs: readonly IAiEditGetDiffPayload[];
  taskId: string;
  runId: string;
  stepId: string;
  appliedAt: string;
}

interface IPatchSummaryIdKeys {
  runId: string;
  stepId: string;
  taskId: string;
  appliedAt: string;
}

interface IChangedFileTotals {
  totalAdditions: number;
  totalDeletions: number;
}

// ──────────────────────────────────────────────────────────────────────
// Ref helpers
// ──────────────────────────────────────────────────────────────────────

export const buildAiAedPatchRef = (taskId: string): string =>
  `${AED_PATCH_REF_PREFIX}${encodeURIComponent(taskId)}`;

export const parseAiAedPatchRef = (patchRef: string): string | null => {
  if (!patchRef.startsWith(AED_PATCH_REF_PREFIX)) return null;
  const encodedTaskId = patchRef.slice(AED_PATCH_REF_PREFIX.length);
  if (!encodedTaskId) return null;
  try {
    const taskId = decodeURIComponent(encodedTaskId).trim();
    return taskId || null;
  } catch {
    return null;
  }
};

// ──────────────────────────────────────────────────────────────────────
// Path normalization (for Map keying)
// ──────────────────────────────────────────────────────────────────────

/**
 * 大小写不敏感文件系统上比较 / Map keying 用的归一化路径。
 * 不要把它当成展示路径，也不要写回数据。
 */
const toMapKeyPath = (path: string): string =>
  normalizeFileSystemPath(path, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: true,
  });

// ──────────────────────────────────────────────────────────────────────
// Hash + ID
// ──────────────────────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit, 以 base36 + 左侧补零输出固定长度，便于在 UI / 日志中视觉对齐。
 * 注意：仅用于「同会话内 patch summary 去重 / 引用」用途，非加密哈希。
 */
const hashString = (value: string): string => fnv1a32Base36(value);

const buildSummaryIdPayload = (
  keys: IPatchSummaryIdKeys,
  files: readonly IAiAgentChangedFile[],
): string =>
  [
    keys.runId,
    keys.stepId,
    keys.taskId,
    keys.appliedAt,
    ...files.map((file) =>
      [file.path, file.status, file.additions, file.deletions, file.diffRef].join('|'),
    ),
  ].join('\n');

const makeSummaryId = (payload: string, namespace?: string): string =>
  namespace
    ? `${PATCH_SUMMARY_ID_PREFIX}:${namespace}:${hashString(payload)}`
    : `${PATCH_SUMMARY_ID_PREFIX}:${hashString(payload)}`;

// ──────────────────────────────────────────────────────────────────────
// Stats / status inference
// ──────────────────────────────────────────────────────────────────────

/**
 * 统计单文件 patch 内的 `+` / `-` 行数。
 * 显式跳过 `+++` / `---` 头部行，且不计上下文行。
 */
export const countAiPatchFileLineStats = (file: IAiPatchFile): IAiPatchFileLineStats => {
  let additions = 0;
  let deletions = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (!line) continue;
      // 头部行（文件名标记）不计入
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      const head = line.charCodeAt(0);
      if (head === 0x2b /* '+' */) additions += 1;
      else if (head === 0x2d /* '-' */) deletions += 1;
    }
  }
  return { additions, deletions };
};

const inferChangedFileStatusFromPatch = (
  file: IAiPatchFile,
  stats: IAiPatchFileLineStats,
): TAiAgentChangedFileStatus => {
  if (
    stats.additions > 0 &&
    stats.deletions === 0 &&
    file.hunks.length > 0 &&
    file.hunks.every((hunk) => hunk.oldLines === 0)
  ) {
    return 'added';
  }
  if (
    stats.deletions > 0 &&
    stats.additions === 0 &&
    file.hunks.length > 0 &&
    file.hunks.every((hunk) => hunk.newLines === 0)
  ) {
    return 'deleted';
  }
  return 'modified';
};

const inferChangedFileStatusFromAedKind = (
  kind: TAiEditOperationKind,
): TAiAgentChangedFileStatus => {
  switch (kind) {
    case 'create':
      return 'added';
    case 'delete':
      return 'deleted';
    case 'rename':
      return 'renamed';
    default:
      return 'modified';
  }
};

/**
 * 合并同一文件在多个 summary 中的状态。
 *
 * 优先级（从高到低）：
 *   - 状态相同：保持不变。
 *   - 任一为 `deleted`：终态删除。
 *   - 任一为 `added`：仍视为新建（"新建后修改"在 UI 上仍是"新建"）。
 *   - 任一为 `renamed`：仍视为重命名。
 *   - 其余：`modified`。
 */
const mergeFileStatus = (
  prev: TAiAgentChangedFileStatus,
  next: TAiAgentChangedFileStatus,
): TAiAgentChangedFileStatus => {
  if (prev === next) return prev;
  if (prev === 'deleted' || next === 'deleted') return 'deleted';
  if (prev === 'added' || next === 'added') return 'added';
  if (prev === 'renamed' || next === 'renamed') return 'renamed';
  return 'modified';
};

// ──────────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────────

const isAppliedPatchFile = (
  file: IAiPatchFile,
  appliedFiles: IAiApplyPatchPayload['appliedFiles'],
): boolean =>
  appliedFiles.some((appliedFile) => areFileSystemPathsEqual(appliedFile.path, file.path));

/** 单趟扫描同时算出 totalAdditions / totalDeletions。 */
const computeChangedFileTotals = (files: readonly IAiAgentChangedFile[]): IChangedFileTotals => {
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const file of files) {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
  }
  return { totalAdditions, totalDeletions };
};

export const buildAiAgentPatchSummaryFromApplyResult = (
  input: IBuildAiAgentPatchSummaryInput,
): IAiAgentPatchSummary | null => {
  const taskId = input.taskId.trim();
  const runId = input.runId.trim();
  const stepId = input.stepId.trim();
  const appliedAt = input.appliedAt.trim();
  if (!taskId || !runId || !stepId || !appliedAt || input.applyResult.appliedFiles.length === 0) {
    return null;
  }

  const files = input.patch.files
    .filter((file) => isAppliedPatchFile(file, input.applyResult.appliedFiles))
    .map<IAiAgentChangedFile>((file) => {
      const stats = countAiPatchFileLineStats(file);
      return {
        path: file.path,
        status: inferChangedFileStatusFromPatch(file, stats),
        additions: stats.additions,
        deletions: stats.deletions,
        diffRef: buildAiAedDiffRef({ taskId, path: file.path }),
      };
    });

  if (files.length === 0) return null;

  const keys: IPatchSummaryIdKeys = { runId, stepId, taskId, appliedAt };
  const totals = computeChangedFileTotals(files);
  return {
    id: makeSummaryId(buildSummaryIdPayload(keys, files)),
    runId,
    stepId,
    files,
    totalAdditions: totals.totalAdditions,
    totalDeletions: totals.totalDeletions,
    patchRef: buildAiAedPatchRef(taskId),
    appliedAt,
  };
};

/**
 * 将单条 AED diff 包装成 `IAiPatchSet`。
 *
 * 备注：`originalHash` 字段在这里塞的是来源标识 `aed:<operationId>`，
 * 不是原文件内容指纹。下游若用作内容寻址 / 乐观锁请勿直接信任。
 */
export const buildAiPatchSetFromAedDiff = (diff: IAiEditGetDiffPayload): IAiPatchSet | null => {
  if (diff.hunks.length === 0) return null;
  return {
    summary: `已修改 ${diff.path}`,
    files: [
      {
        path: diff.path,
        originalHash: `aed:${diff.operationId}`,
        hunks: diff.hunks.map((hunk) => ({
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: hunk.lines,
        })),
      },
    ],
  };
};

export const buildAiAgentPatchSummaryFromAedDiffs = (
  input: IBuildAiAgentPatchSummaryFromDiffsInput,
): IAiAgentPatchSummary | null => {
  const taskId = input.taskId.trim();
  const runId = input.runId.trim();
  const stepId = input.stepId.trim();
  const appliedAt = input.appliedAt.trim();
  if (!taskId || !runId || !stepId || !appliedAt || input.diffs.length === 0) {
    return null;
  }

  const files = input.diffs
    .filter((diff) => diff.hunks.length > 0)
    .map<IAiAgentChangedFile>((diff) => ({
      path: diff.path,
      status: inferChangedFileStatusFromAedKind(diff.kind),
      additions: diff.additions,
      deletions: diff.deletions,
      diffRef: buildAiAedDiffRef({ taskId, path: diff.path }),
    }));

  if (files.length === 0) return null;

  const keys: IPatchSummaryIdKeys = { runId, stepId, taskId, appliedAt };
  const totals = computeChangedFileTotals(files);
  return {
    id: makeSummaryId(buildSummaryIdPayload(keys, files), 'aed-diff'),
    runId,
    stepId,
    files,
    totalAdditions: totals.totalAdditions,
    totalDeletions: totals.totalDeletions,
    patchRef: buildAiAedPatchRef(taskId),
    appliedAt,
  };
};

// ──────────────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────────────

/**
 * 将多个 `IAiAgentPatchSummary` 按文件维度合并。
 *
 * 语义说明（重要，**过程视图**）：
 *   - `additions` / `deletions` 是各 summary 上对应文件 `+ / -` 的**累加**，
 *     反映"流水线上一共发生过多少 + / -"，不是与原文件对比的"净增删"。
 *     如果调用方需要净视图，应基于 `diffRef` 重算，而不是消费此处的数字。
 *   - `status` 按 `mergeFileStatus` 规则收敛；
 *   - `diffRef` 始终采用**最新**一次 summary 的值（"最近一次 diff 胜出"）；
 *   - `patchRef` 取**首条** summary 的值。**前置约束**：所有 summary 应属于同一 task；
 *     若 dev 模式下检测到 `patchRef` 不一致，会在控制台告警。
 *   - `appliedAt` / `revertedAt` 优先末条，缺值则回退首条。**注意**：若仅中间条
 *     存在 `revertedAt`、首末均无，本函数将**丢失**该信息（与历史行为一致）；
 *     若你需要"任一存在即取"语义，请提单独工具函数处理。
 *   - `runId` / `stepId` 取首条；调用方应保证多 summary 属于同一 run/step。
 *
 * 实现说明：跨平台兼容 —— 使用归一化路径作为 Map key，使大小写不敏感文件系统上的
 * `src/App.tsx` 与 `src/app.tsx` 被正确视为同一文件，避免历史实现里 Map miss → O(n)
 * 线性 fallback → 整体 O(N²) 的性能坑。
 */
export const mergeAiAgentPatchSummaries = (
  summaries: readonly IAiAgentPatchSummary[],
): IAiAgentPatchSummary | null => {
  const firstSummary = summaries[0];
  if (!firstSummary) return null;

  if (import.meta.env.DEV) {
    const patchRefs = new Set(summaries.map((s) => s.patchRef));
    if (patchRefs.size > 1) {
      // TODO: 接入 Aster 统一 logger (logger.warn) 替换 console.warn
      // eslint-disable-next-line no-console
      console.warn('[mergeAiAgentPatchSummaries] 输入 summary 的 patchRef 不一致，仅会保留首条:', [
        ...patchRefs,
      ]);
    }
  }

  const files: IAiAgentChangedFile[] = [];
  const indexByKey = new Map<string, number>();

  for (const summary of summaries) {
    for (const file of summary.files) {
      const key = toMapKeyPath(file.path);
      const existingIndex = indexByKey.get(key);

      if (existingIndex === undefined) {
        indexByKey.set(key, files.length);
        files.push({ ...file });
        continue;
      }

      const existingFile = files[existingIndex]!;
      files[existingIndex] = {
        ...existingFile,
        status: mergeFileStatus(existingFile.status, file.status),
        additions: existingFile.additions + file.additions,
        deletions: existingFile.deletions + file.deletions,
        diffRef: file.diffRef,
        ...(file.rollbackRef ? { rollbackRef: file.rollbackRef } : {}),
      };
    }
  }

  if (files.length === 0) return null;

  const lastSummary = summaries[summaries.length - 1] ?? firstSummary;
  const mergedAppliedAt = lastSummary.appliedAt || firstSummary.appliedAt;
  const mergedRevertedAt = lastSummary.revertedAt || firstSummary.revertedAt;
  const totals = computeChangedFileTotals(files);

  return {
    id: makeSummaryId(summaries.map((s) => s.id).join('\n'), 'merged'),
    runId: firstSummary.runId,
    stepId: firstSummary.stepId,
    files,
    totalAdditions: totals.totalAdditions,
    totalDeletions: totals.totalDeletions,
    patchRef: firstSummary.patchRef,
    ...(mergedAppliedAt ? { appliedAt: mergedAppliedAt } : {}),
    ...(mergedRevertedAt ? { revertedAt: mergedRevertedAt } : {}),
  };
};
