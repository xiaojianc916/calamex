import type { IAiContextReference } from '@/types/ai';
import type {
  IActiveRunSummary,
  IAnalyzeScriptPayload,
  IEditorDocument,
  IEditorSelectionSummary,
} from '@/types/editor';
import type { IGitRepositoryStatusPayload } from '@/types/git';

const MAX_CONTEXT_PREVIEW_CHARS = 4000;

const clipPreview = (value: string): string => {
  const chars = [...value];
  if (chars.length <= MAX_CONTEXT_PREVIEW_CHARS) {
    return value;
  }
  return `${chars.slice(0, MAX_CONTEXT_PREVIEW_CHARS).join('')}\n[已截断]`;
};

export const buildCurrentFileReference = (document: IEditorDocument): IAiContextReference | null => {
  if (!document.id || document.kind !== 'text') {
    return null;
  }

  return {
    id: `current-file:${document.path ?? document.id}`,
    kind: 'current-file',
    label: document.name,
    path: document.path,
    range: null,
    contentPreview: clipPreview(document.content),
    redacted: false,
  };
};

export const buildSelectionReference = (
  selection: IEditorSelectionSummary | null,
  document: IEditorDocument,
): IAiContextReference | null => {
  if (!selection || !selection.text.trim() || document.kind !== 'text') {
    return null;
  }

  return {
    id: `selection:${document.id}:${selection.startLine}-${selection.endLine}`,
    kind: 'selection',
    label: `${document.name}:${selection.startLine}-${selection.endLine}`,
    path: document.path,
    range: {
      startLine: selection.startLine,
      endLine: selection.endLine,
    },
    contentPreview: clipPreview(selection.text),
    redacted: false,
  };
};

export const buildActiveRunReference = (
  activeRun: IActiveRunSummary | null,
): IAiContextReference | null => {
  if (!activeRun) {
    return null;
  }

  return {
    id: `terminal-log:${activeRun.runId}`,
    kind: 'terminal-log',
    label: activeRun.documentName,
    path: activeRun.documentPath,
    range: null,
    contentPreview: clipPreview([
      `运行文件：${activeRun.documentName}`,
      `路径：${activeRun.documentPath ?? '未保存'}`,
      `命令：${activeRun.commandLine}`,
      `执行器：${activeRun.executorLabel}`,
      `开始时间：${activeRun.startedAt}`,
      `使用临时文件：${activeRun.usedTempFile ? '是' : '否'}`,
    ].join('\n')),
    redacted: false,
  };
};

export const buildDiagnosticsReference = (
  analysis: IAnalyzeScriptPayload,
  document: IEditorDocument,
): IAiContextReference | null => {
  if (!analysis.available || analysis.diagnostics.length === 0) {
    return null;
  }

  const preview = analysis.diagnostics
    .slice(0, 20)
    .map((item) => [
      `${item.level.toUpperCase()} ${item.code}`,
      `位置：第 ${item.line} 行，第 ${item.column} 列`,
      `范围：${item.line}:${item.column}-${item.endLine}:${item.endColumn}`,
      `消息：${item.message}`,
    ].join('\n'))
    .join('\n---\n');

  return {
    id: `diagnostics:${document.id || document.path || document.name}`,
    kind: 'diagnostics',
    label: `${document.name} · ${analysis.diagnostics.length} 个问题`,
    path: document.path,
    range: null,
    contentPreview: clipPreview(preview),
    redacted: false,
  };
};

export const buildGitDiffReference = (
  status: IGitRepositoryStatusPayload,
): IAiContextReference | null => {
  if (!status.available || status.files.length === 0) {
    return null;
  }

  const preview = [
    `仓库：${status.repositoryName ?? status.repositoryRootPath ?? '未知'}`,
    `分支：${status.headBranchName ?? status.headShortName ?? '未知'}`,
    `状态：staged=${status.stagedCount}, unstaged=${status.unstagedCount}, untracked=${status.untrackedCount}, conflicted=${status.conflictedCount}`,
    '',
    ...status.files.slice(0, 40).map((file) => [
      file.relativePath,
      `index=${file.indexStatus ?? '-'} worktree=${file.worktreeStatus ?? '-'}${file.isUntracked ? ' untracked' : ''}${file.isConflicted ? ' conflicted' : ''}`,
    ].join(' · ')),
  ].join('\n');

  return {
    id: `git-diff:${status.repositoryRootPath ?? 'workspace'}`,
    kind: 'git-diff',
    label: `${status.files.length} 个 Git 变更`,
    path: status.repositoryRootPath,
    range: null,
    contentPreview: clipPreview(preview),
    redacted: false,
  };
};
