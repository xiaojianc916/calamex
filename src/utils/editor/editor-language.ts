import { stripWindowsVerbatimPrefix } from '@/utils/file/path';
import { LANGUAGE_DEFINITIONS } from './language-registry';

/**
 * 根据文件路径或文件名推断编辑器语言 ID。
 * 仅在确认为 shell 脚本时返回 shell,未知类型统一回退为 plaintext。
 *
 * 扩展名 / 精确文件名映射由 language-registry 派生(单一数据源),与 CodeMirror
 * 标签映射共用同一份语言定义,避免两张表漂移。
 */
const buildExtensionMap = (): Readonly<Record<string, string>> => {
  const map: Record<string, string> = {};
  for (const def of LANGUAGE_DEFINITIONS) {
    for (const extension of def.extensions ?? []) {
      map[extension] = def.id;
    }
  }
  return map;
};

const buildExactNameMap = (): Readonly<Record<string, string>> => {
  const map: Record<string, string> = {};
  for (const def of LANGUAGE_DEFINITIONS) {
    for (const fileName of def.filenames ?? []) {
      map[fileName] = def.id;
    }
  }
  return map;
};

const LANGUAGE_BY_EXTENSION = buildExtensionMap();
const LANGUAGE_BY_EXACT_NAME = buildExactNameMap();

const resolveCandidateFileName = (
  filePath: string | null | undefined,
  fileName: string | null | undefined,
): string => {
  const candidate = filePath?.trim() || fileName?.trim() || '';
  if (!candidate) {
    return '';
  }

  const normalizedPath = stripWindowsVerbatimPrefix(candidate);
  const withoutQuery = normalizedPath.toLowerCase().split(/[?#]/u)[0] ?? '';
  return withoutQuery.split(/[\\/]/u).at(-1) ?? '';
};

export const resolveLanguageForPath = (
  filePath: string | null | undefined,
  fileName?: string | null,
): string => {
  const candidateFileName = resolveCandidateFileName(filePath, fileName);
  if (!candidateFileName) {
    return 'plaintext';
  }

  const fileNameWithoutRange = candidateFileName.split(':')[0] ?? candidateFileName;
  const exactLanguage = LANGUAGE_BY_EXACT_NAME[fileNameWithoutRange];
  if (exactLanguage) {
    return exactLanguage;
  }
  if (fileNameWithoutRange.endsWith('.dockerfile')) {
    return 'dockerfile';
  }

  const ext = fileNameWithoutRange.includes('.')
    ? fileNameWithoutRange.split('.').at(-1)
    : undefined;

  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? 'plaintext') : 'plaintext';
};
