import {
  basename as patheBasename,
  dirname as patheDirname,
  normalize as patheNormalize,
} from 'pathe';

export interface INormalizeFileSystemPathOptions {
  collapseDuplicateSeparators?: boolean;
  trimTrailingSeparator?: boolean;
  foldWindowsCase?: boolean;
}

// ---- patterns ---------------------------------------------------------------

const WINDOWS_PATH_PATTERN = /^[a-zA-Z]:\//;
const UNC_PATH_PATTERN = /^\/\//;
const WINDOWS_DISPLAY_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|[\\/]{2}[^\\/])/;
const ABSOLUTE_POSIX_PATH_PATTERN = /^\//;
const WINDOWS_DRIVE_ROOT_PATTERN = /^[a-zA-Z]:\/$/;
const UNC_SHARE_ROOT_PATTERN = /^\/\/[^/]+\/[^/]+\/?$/;

/**
 * 一次性匹配所有 Windows verbatim 前缀（大小写不敏感）：
 *   \\?\UNC\   → UNC share
 *   \\?\       → 普通 verbatim
 *   //?/UNC/   → 已被 pathe 转换为正斜杠的 UNC verbatim
 *   //?/       → 已被 pathe 转换为正斜杠的普通 verbatim
 * 分组 1: UNC 标志（若命中 UNC 形态则为 "UNC" 字样，否则为空）
 */
const VERBATIM_PREFIX_RE = /^(?:\\\\|\/\/)\?[\\/](UNC[\\/])?/i;

// ---- private helpers --------------------------------------------------------

/**
 * 剑离 Windows verbatim 前缀。
 * - UNC 形态：保留双前导分隔符（输入是反斜杠则返回 "\\\\" + rest，否则 "//" + rest）。
 * - 非 UNC 形态：直接丢弃前缀，露出 drive: 等真实路径头。
 * 短路：仅当首字符是 "\\" 或 "/" 时才尝试匹配，避免 hot path 上的 regex 失败开销。
 * 导出供 path 与 editor-language 共用，避免重复实现 Windows 前缀剑离逻辑。
 */
export const stripWindowsVerbatimPrefix = (value: string): string => {
  const head = value.charCodeAt(0);
  // 0x5C = '\\', 0x2F = '/'
  if (head !== 0x5c && head !== 0x2f) return value;

  const match = VERBATIM_PREFIX_RE.exec(value);
  if (!match) return value;

  const rest = value.slice(match[0].length);
  if (match[1]) {
    // UNC 形态：还原成双分隔符 + 主机/共享名
    const isBackslash = value.charCodeAt(0) === 0x5c;
    return (isBackslash ? '\\\\' : '//') + rest;
  }
  return rest;
};

const collapseDuplicateSeparators = (value: string): string => {
  if (value.startsWith('//')) {
    return `//${value.slice(2).replace(/\/+/g, '/')}`;
  }
  return value.replace(/\/+/g, '/');
};

const isWindowsStylePath = (value: string): boolean =>
  WINDOWS_PATH_PATTERN.test(value) || UNC_PATH_PATTERN.test(value);

const isAbsoluteDisplayPath = (value: string): boolean =>
  WINDOWS_DISPLAY_PATH_PATTERN.test(value) || ABSOLUTE_POSIX_PATH_PATTERN.test(value);

const trimTrailingSeparator = (value: string): string => {
  if (
    !value ||
    value === '/' ||
    WINDOWS_DRIVE_ROOT_PATTERN.test(value) ||
    UNC_SHARE_ROOT_PATTERN.test(value)
  ) {
    return value;
  }
  return value.replace(/\/+$/g, '');
};

// ---- public API -------------------------------------------------------------

export const normalizeFileSystemPath = (
  value: string | null | undefined,
  options: INormalizeFileSystemPathOptions = {},
): string => {
  if (!value) return '';

  let normalized = stripWindowsVerbatimPrefix(value);
  normalized = patheNormalize(normalized).replace(/\\/g, '/');
  normalized = stripWindowsVerbatimPrefix(normalized);

  if (options.collapseDuplicateSeparators) {
    normalized = collapseDuplicateSeparators(normalized);
  }
  if (options.trimTrailingSeparator) {
    normalized = trimTrailingSeparator(normalized);
  }
  if (options.foldWindowsCase ?? isWindowsStylePath(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
};

export const formatFileSystemPathForDisplay = (value: string | null | undefined): string => {
  if (!value) return '';
  let formatted = stripWindowsVerbatimPrefix(value);
  formatted = stripWindowsVerbatimPrefix(formatted.replace(/\\/g, '/'));

  if (isWindowsStylePath(formatted)) {
    return collapseDuplicateSeparators(formatted).replace(/\//g, '\\');
  }
  return collapseDuplicateSeparators(formatted);
};

export const formatFileSystemTextForDisplay = (value: string | null | undefined): string => {
  if (!value) return '';
  return value
    .replace(/\\\\\?\\UNC\\/gi, '\\\\')
    .replace(/\\\\\?\\/g, '')
    .replace(/\/\/\?\/UNC\//gi, '//')
    .replace(/\/\/\?\//g, '');
};

export const joinDisplayedPath = (
  prefix: string | null | undefined,
  leaf: string | null | undefined,
): string => {
  const formattedPrefix = formatFileSystemPathForDisplay(prefix).trim();
  const formattedLeaf = formatFileSystemPathForDisplay(leaf)
    .trim()
    .replace(/^[\\/]+/g, '');

  if (!formattedPrefix) return formattedLeaf;
  if (!formattedLeaf) return formattedPrefix;

  if (isAbsoluteDisplayPath(formattedPrefix)) {
    const separator = WINDOWS_DISPLAY_PATH_PATTERN.test(formattedPrefix) ? '\\' : '/';
    return `${formattedPrefix.replace(/[\\/]+$/g, '')}${separator}${formattedLeaf}`;
  }
  return `${formattedPrefix} / ${formattedLeaf}`;
};

export const areFileSystemPathsEqual = (
  left: string | null | undefined,
  right: string | null | undefined,
): boolean => {
  const opts: INormalizeFileSystemPathOptions = {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
  };
  return normalizeFileSystemPath(left, opts) === normalizeFileSystemPath(right, opts);
};

export const getPathBaseName = (value: string | null | undefined): string => {
  const normalized = normalizeFileSystemPath(value, { trimTrailingSeparator: true });
  if (!normalized) return '';
  return patheBasename(normalized);
};

export const getRelativeFileSystemPath = (
  fullPath: string | null | undefined,
  rootPath: string | null | undefined,
): string | null => {
  const normalizedFullPath = normalizeFileSystemPath(fullPath, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
  });
  const normalizedRootPath = normalizeFileSystemPath(rootPath, {
    collapseDuplicateSeparators: true,
    trimTrailingSeparator: true,
  });

  if (!normalizedFullPath || !normalizedRootPath) return null;
  if (normalizedFullPath === normalizedRootPath) return '';

  const rootWithSep = normalizedRootPath.endsWith('/')
    ? normalizedRootPath
    : `${normalizedRootPath}/`;

  if (!normalizedFullPath.startsWith(rootWithSep)) return null;
  return normalizedFullPath.slice(rootWithSep.length);
};

export const getPathDirectory = (value: string | null | undefined): string => {
  const normalized = normalizeFileSystemPath(value, { trimTrailingSeparator: true });
  if (!normalized) return '';
  const dir = patheDirname(normalized);
  return dir === '.' ? '' : `${dir}/`;
};
