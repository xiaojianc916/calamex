import { normalizeFileSystemPath } from '@/utils/path';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const SHELL_SCRIPT_EXTENSIONS = new Set(['sh', 'bash']);

const getFileExtension = (path: string | null | undefined): string => {
  if (!path) {
    return '';
  }

  const normalizedPath = normalizeFileSystemPath(path);
  const extension = normalizedPath.split('.').pop();
  return extension ? extension.toLowerCase() : '';
};

export const isImageAssetPath = (path: string | null | undefined): boolean =>
  IMAGE_EXTENSIONS.has(getFileExtension(path));

export const isShellScriptPath = (path: string | null | undefined): boolean =>
  SHELL_SCRIPT_EXTENSIONS.has(getFileExtension(path));

export const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};
