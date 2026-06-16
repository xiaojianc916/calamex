import { tauriService } from '@/services/tauri';
import type { IAiPatchSet } from '@/types/ai';
import { AGENT_RUNTIME_EVENT_SCHEMA_VERSION, type TAgentRuntimeEvent } from '@/types/ai/sidecar';
import type { IAnalyzeScriptPayload } from '@/types/editor';
import { toErrorMessage } from '@/utils/error/error';
import { areFileSystemPathsEqual } from '@/utils/file/path';

import { materializePatchedContent, normalizePatchDisplayPath } from './useAiAssistant.patch';
import { createScopedId } from './useAiAssistant.runtime-events';

// ---------------------------------------------------------------------------
// ShellCheck diagnostics for applied shell-script patches
// (extracted from useAiAssistant.patch.ts to keep each slice within size limits).
// ---------------------------------------------------------------------------

const SHELL_SCRIPT_FILE_PATTERN = /\.(?:sh|bash|dash|ksh|bats)$/iu;

const getPathFileName = (path: string): string => {
  const normalized = path.replace(/\\/gu, '/');
  const fileName = normalized
    .split('/')
    .filter((part) => part.length > 0)
    .at(-1);

  return fileName ?? path;
};

const hasShellShebang = (content: string): boolean => {
  const firstLine = content.split(/\r?\n/u, 1)[0]?.toLocaleLowerCase() ?? '';

  return firstLine.startsWith('#!') && /\b(?:ba|da|k)?sh\b/u.test(firstLine);
};

const shouldRunShellCheckForPatchFile = (path: string, content: string): boolean =>
  SHELL_SCRIPT_FILE_PATTERN.test(path) || hasShellShebang(content);

const countShellCheckDiagnostics = (
  diagnostics: readonly IAnalyzeScriptPayload['diagnostics'][number][],
): { errors: number; warnings: number; infos: number } => {
  let errors = 0;
  let warnings = 0;
  let infos = 0;

  for (const diagnostic of diagnostics) {
    if (diagnostic.level === 'error') {
      errors += 1;
    } else if (diagnostic.level === 'warning') {
      warnings += 1;
    } else {
      infos += 1;
    }
  }

  return { errors, warnings, infos };
};

const collectShellCheckDiagnosticCodes = (
  diagnostics: readonly IAnalyzeScriptPayload['diagnostics'][number][],
): string[] => {
  const codes = new Set<string>();

  for (const diagnostic of diagnostics) {
    const code = diagnostic.code.trim().toUpperCase();

    if (code) {
      codes.add(code);
    }
  }

  return [...codes];
};

const formatShellCheckCounts = (counts: {
  errors: number;
  warnings: number;
  infos: number;
}): string =>
  [
    counts.errors > 0 ? `${counts.errors} 错误` : '',
    counts.warnings > 0 ? `${counts.warnings} 警告` : '',
    counts.infos > 0 ? `${counts.infos} 提示` : '',
  ]
    .filter((item) => item.length > 0)
    .join('、');

const summarizeShellCheckAnalysis = (path: string, analysis: IAnalyzeScriptPayload): string => {
  const displayPath = normalizePatchDisplayPath(path);

  if (!analysis.available) {
    return `${displayPath}：ShellCheck 不可用${analysis.message ? `，${analysis.message}` : ''}`;
  }

  if (analysis.diagnostics.length === 0) {
    return `${displayPath}：ShellCheck 通过（${analysis.dialect}）`;
  }

  const counts = countShellCheckDiagnostics(analysis.diagnostics);
  const diagnosticCodes = collectShellCheckDiagnosticCodes(analysis.diagnostics);
  const firstDiagnostic = analysis.diagnostics[0];
  const diagnosticCodesText =
    diagnosticCodes.length > 0 ? `；问题编号 ${diagnosticCodes.join('、')}` : '';
  const firstDiagnosticText = firstDiagnostic
    ? `；首个问题 L${firstDiagnostic.line}:${firstDiagnostic.column} ${firstDiagnostic.message}`
    : '';

  return `${displayPath}：ShellCheck ${formatShellCheckCounts(counts)}${diagnosticCodesText}${firstDiagnosticText}`;
};

const createHostToolCompletedRuntimeEvent = (input: {
  runId: string;
  sessionId: string;
  seq: number;
  toolName: string;
  ok: boolean;
  resultPreview?: string;
  errorMessage?: string;
  level?: TAgentRuntimeEvent['level'];
}): TAgentRuntimeEvent => ({
  id: createScopedId(`host-${input.toolName}`),
  type: 'agent.tool.completed',
  runId: input.runId,
  sessionId: input.sessionId,
  agentId: 'host',
  timestamp: new Date().toISOString(),
  seq: input.seq,
  schemaVersion: AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
  redacted: true,
  visibility: 'user',
  ...(input.level ? { level: input.level } : {}),
  toolName: input.toolName,
  ok: input.ok,
  ...(input.resultPreview ? { resultPreview: input.resultPreview } : {}),
  ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
});

export const runShellCheckForAppliedPatch = async (input: {
  patch: IAiPatchSet;
  appliedPaths: readonly string[];
  runId: string;
  sessionId: string;
  seqStart: number;
}): Promise<TAgentRuntimeEvent[]> => {
  const events: TAgentRuntimeEvent[] = [];
  let seq = input.seqStart;

  for (const file of input.patch.files) {
    const wasApplied = input.appliedPaths.some((path) => areFileSystemPathsEqual(path, file.path));

    if (!wasApplied) {
      continue;
    }

    const content = materializePatchedContent(file);

    if (content === null || !shouldRunShellCheckForPatchFile(file.path, content)) {
      continue;
    }

    try {
      const analysis = await tauriService.analyzeScript({
        path: file.path,
        name: getPathFileName(file.path),
        content,
      });
      const counts = countShellCheckDiagnostics(analysis.diagnostics);
      const hasErrors = counts.errors > 0;
      const hasWarnings = counts.warnings > 0 || counts.infos > 0;

      events.push(
        createHostToolCompletedRuntimeEvent({
          runId: input.runId,
          sessionId: input.sessionId,
          seq,
          toolName: 'shellcheck',
          ok: analysis.available && !hasErrors,
          level: !analysis.available || hasErrors ? 'error' : hasWarnings ? 'warn' : 'info',
          resultPreview: summarizeShellCheckAnalysis(file.path, analysis),
          ...(!analysis.available && analysis.message ? { errorMessage: analysis.message } : {}),
        }),
      );
      seq += 1;
    } catch (error) {
      const message = toErrorMessage(error, 'ShellCheck 诊断失败。');

      events.push(
        createHostToolCompletedRuntimeEvent({
          runId: input.runId,
          sessionId: input.sessionId,
          seq,
          toolName: 'shellcheck',
          ok: false,
          level: 'error',
          errorMessage: message,
          resultPreview: `${normalizePatchDisplayPath(file.path)}：${message}`,
        }),
      );
      seq += 1;
    }
  }

  return events;
};
