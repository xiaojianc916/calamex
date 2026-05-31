import { isNonEmptyString } from './text';

const SHELLCHECK_CODE_PATTERN = /\bSC\d{4}\b/giu;

export const extractShellcheckDiagnosticCodes = (value: string | undefined): string[] => {
  if (!isNonEmptyString(value)) {
    return [];
  }

  const matches = value.toUpperCase().match(SHELLCHECK_CODE_PATTERN) ?? [];
  return [...new Set(matches)];
};

export const hasShellcheckPassSummary = (value: string | undefined): boolean =>
  isNonEmptyString(value) && value.includes('ShellCheck 通过');

export const hasShellcheckUnavailableSummary = (value: string | undefined): boolean =>
  isNonEmptyString(value) && value.includes('ShellCheck 不可用');

export const formatShellcheckIssueAction = (codes: readonly string[]): string =>
  codes.length > 0 ? `语法存在一些问题：${codes.join('、')}` : '语法存在一些问题';
