import type {
  IAiDiffHunkPreview,
  IAiDiffPreviewLine,
  IAiPatchFile,
  IAiPatchHunk,
  IAiPatchSet,
} from '@/types/ai';
import type { IGitDiffPreviewPayload } from '@/types/git';
import { fnv1a32 } from '@/utils/core/hash';
import { areFileSystemPathsEqual, normalizeFileSystemPath } from '@/utils/file/path';

export interface IAiPatchPreviewFile {
  path: string;
  displayPath: string;
  hunks: IAiDiffHunkPreview[];
  gitDiffPreview: IGitDiffPreviewPayload;
}

interface ILineCursor {
  oldLineNumber: number;
  newLineNumber: number;
}

interface IMaterializedPatchContent {
  originalContent: string;
  modifiedContent: string;
  /** 任意 hunk 含 + 或 - 行；为 false 时整 patch 实质无变更。 */
  hasMaterialChange: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Path helpers
// ──────────────────────────────────────────────────────────────────────

export const formatAiPatchDisplayPath = (path: string): string => {
  const normalized = normalizeFileSystemPath(path, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: false,
  });
  return normalized || path;
};

/**
 * 比较用的 path 形态：折叠 Windows 大小写，便于 prefix / 等价判断。
 * 不要把这个值作为展示路径——展示路径请用 {@link formatAiPatchDisplayPath}。
 */
const toComparablePath = (path: string): string =>
  normalizeFileSystemPath(path, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
    foldWindowsCase: true,
  });

const getPatchRelativePath = (
  filePath: string,
  workspaceRootPath: string | null | undefined,
): string => {
  const displayPath = formatAiPatchDisplayPath(filePath);
  const displayRoot = formatAiPatchDisplayPath(workspaceRootPath ?? '');

  if (!displayRoot) return displayPath;
  if (areFileSystemPathsEqual(displayPath, displayRoot)) return '';

  const comparablePath = toComparablePath(displayPath);
  const comparableRoot = toComparablePath(displayRoot);
  if (comparablePath === comparableRoot) return '';

  // normalizeFileSystemPath 内部统一把 \ 转为 /，所以分隔符固定是 /。
  // 同时 displayRoot 与 comparableRoot 仅大小写不同，长度严格相等 —— 这是
  // 下面 displayPath.slice(displayRoot.length + 1) 能保留原始大小写的前提。
  const rootWithSep = `${comparableRoot}/`;
  if (comparablePath.startsWith(rootWithSep)) {
    return displayPath.slice(displayRoot.length + 1);
  }
  return displayPath;
};

// ──────────────────────────────────────────────────────────────────────
// Hunk header / ref / id
// ──────────────────────────────────────────────────────────────────────

const formatPatchRange = (start: number, lines: number): string =>
  lines === 1 ? String(start) : `${start},${lines}`;

const buildPatchHunkHeader = (hunk: IAiPatchHunk): string =>
  `@@ -${formatPatchRange(hunk.oldStart, hunk.oldLines)} +${formatPatchRange(
    hunk.newStart,
    hunk.newLines,
  )} @@`;

const buildPatchDiffRef = (displayPath: string): string =>
  `patch-preview:${encodeURIComponent(displayPath)}`;

const buildPatchDiffPreviewId = (file: IAiPatchFile, displayPath: string): string => {
  const source = [
    displayPath,
    file.originalHash,
    ...file.hunks.flatMap((hunk) => [
      String(hunk.oldStart),
      String(hunk.oldLines),
      String(hunk.newStart),
      String(hunk.newLines),
      ...hunk.lines,
    ]),
  ].join('\n');
  return `patch-diff:${fnv1a32(source)}`;
};

// ──────────────────────────────────────────────────────────────────────
// Unified-diff line classification
// ──────────────────────────────────────────────────────────────────────

type DiffLineClassification =
  | { kind: 'skip' } //                          头部 +++ / --- / '\ No newline at end of file'
  | { kind: 'add'; content: string }
  | { kind: 'delete'; content: string }
  | { kind: 'context'; content: string };

/**
 * 将 unified diff 的一行分类为 add / delete / context / skip。
 * skip 涵盖：
 *   - `+++ ...` / `--- ...` 文件标记
 *   - `\` 开头的元信息（如 `\ No newline at end of file`）
 *   - 真正空字符串（防御性）
 */
const classifyDiffLine = (line: string): DiffLineClassification => {
  if (!line) return { kind: 'skip' };
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) {
    return { kind: 'skip' };
  }
  if (line.startsWith('+')) return { kind: 'add', content: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'delete', content: line.slice(1) };
  if (line.startsWith(' ')) return { kind: 'context', content: line.slice(1) };
  // 非标准行兜底按 context 处理（极少出现的 AI 输出毛刺）
  return { kind: 'context', content: line };
};

// ──────────────────────────────────────────────────────────────────────
// Hunk preview lines
// ──────────────────────────────────────────────────────────────────────

const buildLinePreview = (
  filePathForId: string,
  hunkIndex: number,
  line: string,
  lineIndex: number,
  cursor: ILineCursor,
): IAiDiffPreviewLine | null => {
  const classified = classifyDiffLine(line);
  if (classified.kind === 'skip') return null;

  const id = `${filePathForId}:${hunkIndex}:${lineIndex}`;

  if (classified.kind === 'add') {
    const item: IAiDiffPreviewLine = {
      id,
      kind: 'add',
      content: classified.content,
      newLineNumber: cursor.newLineNumber,
    };
    cursor.newLineNumber += 1;
    return item;
  }

  if (classified.kind === 'delete') {
    const item: IAiDiffPreviewLine = {
      id,
      kind: 'delete',
      content: classified.content,
      oldLineNumber: cursor.oldLineNumber,
    };
    cursor.oldLineNumber += 1;
    return item;
  }

  const item: IAiDiffPreviewLine = {
    id,
    kind: 'context',
    content: classified.content,
    oldLineNumber: cursor.oldLineNumber,
    newLineNumber: cursor.newLineNumber,
  };
  cursor.oldLineNumber += 1;
  cursor.newLineNumber += 1;
  return item;
};

const buildPatchPreviewHunks = (file: IAiPatchFile, displayPath: string): IAiDiffHunkPreview[] => {
  const diffRef = buildPatchDiffRef(displayPath);
  return file.hunks.map((hunk, hunkIndex) => {
    const cursor: ILineCursor = {
      oldLineNumber: hunk.oldStart,
      newLineNumber: hunk.newStart,
    };
    return {
      id: `${displayPath}:${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`,
      filePath: displayPath,
      diffRef,
      header: buildPatchHunkHeader(hunk),
      lines: hunk.lines
        .map((line, lineIndex) => buildLinePreview(displayPath, hunkIndex, line, lineIndex, cursor))
        .filter((line): line is IAiDiffPreviewLine => line !== null),
    };
  });
};

// ──────────────────────────────────────────────────────────────────────
// Materialized content (hunk-only, but line-number aligned)
// ──────────────────────────────────────────────────────────────────────

/** 把 lines 数组扩容到 target - 1 长（1-indexed 起点对应数组的下一次 push）。 */
const padLinesTo = (lines: string[], cursor: number, target: number): number => {
  let next = cursor;
  while (next < target) {
    lines.push('');
    next += 1;
  }
  return next;
};

/**
 * 把 patch 重建成两侧字符串，并顺便判定整 patch 是否含实质变更。
 *
 * 设计：**hunk-only**——不读取真实文件内容，只重建 patch 覆盖到的区段。
 *
 * 对齐策略：在每个 hunk 之前按 `hunk.oldStart` / `hunk.newStart` 补足空行，
 * 让 `originalLines[i]` 准确对应原文件第 `i + 1` 行（modified 同理）。
 * 这样：
 *   - 多 hunk 之间的间隙不再被吞，行号不再错位；
 *   - 但代价是：相距很远的两个 hunk 之间会产生大量空行（仍远小于真实文件读取的成本）。
 *
 * 不在两个 hunk 之间插入 `…` 占位文本，避免被下游 diff 算法当作上下文行参与匹配。
 *
 * 同时返回 `hasMaterialChange`，避免上层再扫一次 hunks 做 classify。
 */
const materializePatchContent = (file: IAiPatchFile): IMaterializedPatchContent => {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];

  // cursor 表示"下一个待写入的真实文件行号"，1-indexed。
  let originalCursor = 1;
  let modifiedCursor = 1;
  let hasMaterialChange = false;

  for (const hunk of file.hunks) {
    originalCursor = padLinesTo(originalLines, originalCursor, hunk.oldStart);
    modifiedCursor = padLinesTo(modifiedLines, modifiedCursor, hunk.newStart);

    for (const line of hunk.lines) {
      const classified = classifyDiffLine(line);
      switch (classified.kind) {
        case 'skip':
          continue;
        case 'add':
          modifiedLines.push(classified.content);
          modifiedCursor += 1;
          hasMaterialChange = true;
          continue;
        case 'delete':
          originalLines.push(classified.content);
          originalCursor += 1;
          hasMaterialChange = true;
          continue;
        case 'context':
          originalLines.push(classified.content);
          modifiedLines.push(classified.content);
          originalCursor += 1;
          modifiedCursor += 1;
          continue;
        default: {
          // 编译期穷尽检查 + 运行期硬失败（防止未来新增 kind 时静默吞错）
          const _exhaustive: never = classified;
          throw new Error(
            `materializePatchContent: 未处理的 diff 行分类 ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    }
  }

  return {
    originalContent: originalLines.join('\n'),
    modifiedContent: modifiedLines.join('\n'),
    hasMaterialChange,
  };
};

// ──────────────────────────────────────────────────────────────────────
// Git diff preview payload
// ──────────────────────────────────────────────────────────────────────

const buildGitDiffPreview = (
  file: IAiPatchFile,
  displayPath: string,
  workspaceRootPath: string | null | undefined,
): IGitDiffPreviewPayload => {
  const relativePath = getPatchRelativePath(file.path, workspaceRootPath);
  const { originalContent, modifiedContent, hasMaterialChange } = materializePatchContent(file);

  return {
    id: buildPatchDiffPreviewId(file, displayPath),
    repositoryRootPath: formatAiPatchDisplayPath(workspaceRootPath ?? ''),
    path: displayPath,
    relativePath,
    title: `${relativePath || displayPath} · Patch Diff`,
    mode: 'worktree',
    originalContent,
    modifiedContent,
    // 真正 "没有改动" = 任何 hunk 里都不包含 + / - 数据行。
    // 不用字符串相等判定（避免 -foo/+foo 抵消时被误判为 empty）。
    isEmpty: !hasMaterialChange,
  };
};

// ──────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────

export const buildAiPatchPreviewFiles = (
  patch: IAiPatchSet,
  workspaceRootPath: string | null | undefined,
): IAiPatchPreviewFile[] =>
  patch.files.map((file) => {
    const displayPath = formatAiPatchDisplayPath(file.path);
    return {
      path: file.path,
      displayPath,
      hunks: buildPatchPreviewHunks(file, displayPath),
      gitDiffPreview: buildGitDiffPreview(file, displayPath, workspaceRootPath),
    };
  });
