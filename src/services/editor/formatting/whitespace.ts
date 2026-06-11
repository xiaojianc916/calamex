import type { IWhitespaceConventions } from './types';

/** 统一换行为 LF。 */
export const normalizeLineEndings = (content: string): string =>
  content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** 去除每行行尾的空格与制表符。避免 split/map 整篇分配，保存路径上保持单次线性扫描。 */
export const trimTrailingWhitespace = (content: string): string =>
  content.replace(/[\t ]+(?=\n|$)/gu, '');

/** 按需保证 / 去除文件末尾换行。 */
export const applyFinalNewline = (content: string, insertFinalNewline: boolean): string => {
  if (insertFinalNewline) {
    return content.length > 0 ? content.replace(/[\r\n]*$/u, '\n') : '';
  }
  return content.replace(/[\r\n]+$/u, '');
};

/**
 * 应用保存约定（whitespace 归一）。与 useDocumentPersistence 旧实现
 * normalizeDocumentContentForSave 逐字等价，便于无行为差异迁移。
 */
export const applyWhitespaceConventions = (
  content: string,
  conventions: IWhitespaceConventions,
): string => {
  let next = normalizeLineEndings(content);
  if (conventions.trimTrailingWhitespace) {
    next = trimTrailingWhitespace(next);
  }
  return applyFinalNewline(next, conventions.insertFinalNewline);
};
