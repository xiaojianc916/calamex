import type { IAiAgentPatchSummary, IAiPatchSet } from '@/types/ai';
import type { TAgentUiEvent } from '@/types/ai/sidecar';
import type { IEditorDocument } from '@/types/editor';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/path';

// ---------------------------------------------------------------------------
// Patch reverse / materialize / sidecar patch parsing (extracted from useAiAssistant.ts).
// ShellCheck analysis for applied patches lives in ./useAiAssistant.shellcheck.
// ---------------------------------------------------------------------------

const SIDECAR_PATCH_TOOL_NAMES = new Set(['apply_file_edits', 'propose_file_patch']);

export interface ISidecarPatchEntry {
  patch: IAiPatchSet;
  alreadyApplied: boolean;
}

const reversePatchLine = (line: string): string => {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return line;
  }

  if (line.startsWith('+')) {
    return `-${line.slice(1)}`;
  }

  if (line.startsWith('-')) {
    return `+${line.slice(1)}`;
  }

  return line;
};

const PATH_EQUALITY_NORMALIZE_OPTIONS = {
  collapseDuplicateSeparators: true,
  trimTrailingSeparator: true,
} as const;

/**
 * 与 areFileSystemPathsEqual 完全相同的归一化口径，用作 Set 的成员 key。
 * 二者必须保持一致：否则同一文件可能在 Set 里被算成两个不同 key，导致回滚集漏文件。
 */
const toPathEqualityKey = (path: string): string =>
  normalizeFileSystemPath(path, PATH_EQUALITY_NORMALIZE_OPTIONS);

export const buildReversePatchSet = (
  patches: readonly IAiPatchSet[] | undefined,
  summary: IAiAgentPatchSummary,
): IAiPatchSet | null => {
  // 把 summary 的文件路径预归一化进 Set：成员判断 O(1)。
  // 原实现对每个补丁文件都做 summary.files.some(... areFileSystemPathsEqual) 线性扫描，
  // 总复杂度 O(补丁文件数 × summary 文件数)，且每次比较都重复归一化两条路径；
  // 现在降到 O(补丁文件数 + summary 文件数)，每条路径只归一化一次。
  const summaryPathKeys = new Set(summary.files.map((file) => toPathEqualityKey(file.path)));

  const files = (patches ?? [])
    .flatMap((patch) => patch.files)
    .filter((patchFile) => summaryPathKeys.has(toPathEqualityKey(patchFile.path)))
    .map((file) => ({
      path: file.path,
      originalHash: file.originalHash,
      hunks: file.hunks.map((hunk) => ({
        oldStart: hunk.newStart,
        oldLines: hunk.newLines,
        newStart: hunk.oldStart,
        newLines: hunk.oldLines,
        lines: hunk.lines.map(reversePatchLine),
      })),
    }));

  return files.length > 0
    ? {
        summary: `回滚 ${summary.files.length} 个文件的 AI 修改`,
        files,
      }
    : null;
};

export const normalizePatchDisplayPath = (path: string): string => {
  const normalized = normalizeFileSystemPath(path, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: false,
  });

  return normalized || path;
};

export const materializePatchedContent = (
  patchFile: IAiPatchSet['files'][number],
): string | null => {
  const output: string[] = [];

  for (const hunk of patchFile.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+') || line.startsWith(' ')) {
        output.push(line.slice(1));
        continue;
      }

      if (line.startsWith('-')) {
        continue;
      }

      return null;
    }
  }

  return output.join('\n');
};

export const countDocumentLines = (content: string): number => {
  if (!content.length) {
    return 1;
  }

  return content.split('\n').length;
};

export const syncPatchedDocument = (
  document: IEditorDocument,
  patch: IAiPatchSet,
  appliedPaths: string[],
): void => {
  if (!document.path || document.kind !== 'text') {
    return;
  }

  const patchFile = patch.files.find((file) => areFileSystemPathsEqual(file.path, document.path));

  if (!patchFile) {
    return;
  }

  const wasApplied = appliedPaths.some((path) => areFileSystemPathsEqual(path, patchFile.path));

  if (!wasApplied) {
    return;
  }

  const nextContent = materializePatchedContent(patchFile);

  if (nextContent === null) {
    return;
  }

  document.path = normalizePatchDisplayPath(patchFile.path);
  document.content = nextContent;
  document.savedContent = nextContent;
  document.isDirty = false;
  document.lineCount = countDocumentLines(nextContent);
  document.charCount = [...nextContent].length;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(value);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isPatchHunk = (value: unknown): value is IAiPatchSet['files'][number]['hunks'][number] => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.oldStart === 'number' &&
    typeof value.oldLines === 'number' &&
    typeof value.newStart === 'number' &&
    typeof value.newLines === 'number' &&
    Array.isArray(value.lines) &&
    value.lines.every((line) => typeof line === 'string')
  );
};

const isPatchFile = (value: unknown): value is IAiPatchSet['files'][number] => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.path === 'string' &&
    typeof value.originalHash === 'string' &&
    (value.originalModifiedAtMs === undefined ||
      value.originalModifiedAtMs === null ||
      typeof value.originalModifiedAtMs === 'number') &&
    Array.isArray(value.hunks) &&
    value.hunks.every(isPatchHunk)
  );
};

const isPatchSet = (value: unknown): value is IAiPatchSet => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.summary === 'string' &&
    Array.isArray(value.files) &&
    value.files.every(isPatchFile)
  );
};

const extractPatchEntryFromToolOutput = (output: unknown): ISidecarPatchEntry | null => {
  const normalizedOutput = typeof output === 'string' ? parseJsonObject(output) : output;

  if (!isRecord(normalizedOutput)) {
    return null;
  }

  const patch = normalizedOutput.patch;

  return isPatchSet(patch)
    ? {
        patch,
        alreadyApplied: normalizedOutput.applied === true,
      }
    : null;
};

export const extractSidecarPatchEntries = (
  events: readonly TAgentUiEvent[],
): ISidecarPatchEntry[] =>
  events.flatMap((event) => {
    if (event.type !== 'tool_result' || !SIDECAR_PATCH_TOOL_NAMES.has(event.toolName)) {
      return [];
    }

    const patchEntry = extractPatchEntryFromToolOutput(event.output);

    return patchEntry ? [patchEntry] : [];
  });
