import type {
  IAiApplyPatchPayload,
  IAiPatchFile,
  IAiPatchSet,
} from '@/types/ai';
import type { IAiEditGetDiffPayload, TAiEditOperationKind } from '@/types/ai-edit';
import type {
  IAiAgentChangedFile,
  IAiAgentPatchSummary,
  TAiAgentChangedFileStatus,
} from '@/types/ai-patch';
import { buildAiAedDiffRef } from '@/utils/ai-diff-ref';
import { areFileSystemPathsEqual } from '@/utils/path';

const AED_PATCH_REF_PREFIX = 'aed-patch:';
const HASH_OFFSET_BASIS = 2_166_136_261;
const HASH_PRIME = 16_777_619;

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

export const buildAiAedPatchRef = (taskId: string): string =>
  `${AED_PATCH_REF_PREFIX}${encodeURIComponent(taskId)}`;

export const parseAiAedPatchRef = (patchRef: string): string | null => {
  if (!patchRef.startsWith(AED_PATCH_REF_PREFIX)) {
    return null;
  }

  const encodedTaskId = patchRef.slice(AED_PATCH_REF_PREFIX.length);

  if (!encodedTaskId) {
    return null;
  }

  try {
    const taskId = decodeURIComponent(encodedTaskId).trim();

    return taskId || null;
  } catch {
    return null;
  }
};

const hashString = (value: string): string => {
  let hash = HASH_OFFSET_BASIS;

  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, HASH_PRIME);
  }

  return (hash >>> 0).toString(36);
};

export const countAiPatchFileLineStats = (file: IAiPatchFile): IAiPatchFileLineStats =>
  file.hunks.reduce<IAiPatchFileLineStats>(
    (total, hunk) => hunk.lines.reduce<IAiPatchFileLineStats>(
      (lineTotal, line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return {
            additions: lineTotal.additions + 1,
            deletions: lineTotal.deletions,
          };
        }

        if (line.startsWith('-') && !line.startsWith('---')) {
          return {
            additions: lineTotal.additions,
            deletions: lineTotal.deletions + 1,
          };
        }

        return lineTotal;
      },
      total,
    ),
    { additions: 0, deletions: 0 },
  );

const inferChangedFileStatus = (
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
    case 'modify':
    default:
      return 'modified';
  }
};

const isAppliedPatchFile = (
  file: IAiPatchFile,
  appliedFiles: IAiApplyPatchPayload['appliedFiles'],
): boolean =>
  appliedFiles.some((appliedFile) => areFileSystemPathsEqual(appliedFile.path, file.path));

const createPatchSummaryId = (
  input: IBuildAiAgentPatchSummaryInput,
  files: IAiAgentChangedFile[],
): string => {
  const idPayload = [
    input.runId,
    input.stepId,
    input.taskId,
    input.appliedAt,
    ...files.map((file) =>
      [
        file.path,
        file.status,
        file.additions,
        file.deletions,
        file.diffRef,
      ].join('|'),
    ),
  ].join('\n');

  return `patch-summary:${hashString(idPayload)}`;
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
        status: inferChangedFileStatus(file, stats),
        additions: stats.additions,
        deletions: stats.deletions,
        diffRef: buildAiAedDiffRef({ taskId, path: file.path }),
      };
    });

  if (files.length === 0) {
    return null;
  }

  const totalAdditions = files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0);

  return {
    id: createPatchSummaryId(input, files),
    runId,
    stepId,
    files,
    totalAdditions,
    totalDeletions,
    patchRef: buildAiAedPatchRef(taskId),
    appliedAt,
  };
};

export const buildAiPatchSetFromAedDiff = (
  diff: IAiEditGetDiffPayload,
): IAiPatchSet | null => {
  if (diff.hunks.length === 0) {
    return null;
  }

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

  if (files.length === 0) {
    return null;
  }

  const totalAdditions = files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0);
  const idPayload = [
    runId,
    stepId,
    taskId,
    appliedAt,
    ...files.map((file) =>
      [
        file.path,
        file.status,
        file.additions,
        file.deletions,
        file.diffRef,
      ].join('|'),
    ),
  ].join('\n');

  return {
    id: `patch-summary:aed-diff:${hashString(idPayload)}`,
    runId,
    stepId,
    files,
    totalAdditions,
    totalDeletions,
    patchRef: buildAiAedPatchRef(taskId),
    appliedAt,
  };
};

export const mergeAiAgentPatchSummaries = (
  summaries: readonly IAiAgentPatchSummary[],
): IAiAgentPatchSummary | null => {
  const firstSummary = summaries[0];

  if (!firstSummary) {
    return null;
  }

  const files: IAiAgentChangedFile[] = [];

  for (const summary of summaries) {
    for (const file of summary.files) {
      const existingIndex = files.findIndex((item) => areFileSystemPathsEqual(item.path, file.path));
      const existingFile = existingIndex >= 0 ? files[existingIndex] : undefined;

      if (!existingFile) {
        files.push({ ...file });
        continue;
      }

      files[existingIndex] = {
        ...existingFile,
        status: existingFile.status === file.status ? existingFile.status : 'modified',
        additions: existingFile.additions + file.additions,
        deletions: existingFile.deletions + file.deletions,
        diffRef: file.diffRef,
        ...(file.rollbackRef ? { rollbackRef: file.rollbackRef } : {}),
      };
    }
  }

  if (files.length === 0) {
    return null;
  }

  const lastSummary = summaries[summaries.length - 1] ?? firstSummary;
  const totalAdditions = files.reduce((total, file) => total + file.additions, 0);
  const totalDeletions = files.reduce((total, file) => total + file.deletions, 0);

  return {
    id: `patch-summary:merged:${hashString(summaries.map((summary) => summary.id).join('\n'))}`,
    runId: firstSummary.runId,
    stepId: firstSummary.stepId,
    files,
    totalAdditions,
    totalDeletions,
    patchRef: firstSummary.patchRef,
    ...(lastSummary.appliedAt ? { appliedAt: lastSummary.appliedAt } : {}),
    ...(lastSummary.revertedAt ? { revertedAt: lastSummary.revertedAt } : {}),
  };
};
