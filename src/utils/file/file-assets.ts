import { getPathBaseName } from '@/utils/file/path';

// 注意：如需扩展图片格式，请同步更新 file-icons.ts 中的 Pierre 主题 fileExtensions 映射。
// 长期计划：将文件类型分类（isImageAssetPath / isShellScriptPath）抽取到
// utils/file/file-classification.ts 作为唯一入口，图标系统只管「类型→图标」。
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);
const SHELL_SCRIPT_EXTENSIONS = new Set(['sh', 'bash']);

/**
 * 从路径中提取文件扩展名（小写）。
 * 使用 getPathBaseName 取末段，避免对整条路径做规范化；
 * 用 lastIndexOf 正确处理多段扩展名（如 .tar.gz 只取 gz）。
 */
const getFileExtension = (path: string | null | undefined): string => {
  if (!path) {
    return '';
  }

  const baseName = getPathBaseName(path);
  const dotIndex = baseName.lastIndexOf('.');
  // dotIndex <= 0: 无扩展名或隐藏文件（如 .bashrc）
  if (dotIndex <= 0) {
    return '';
  }
  return baseName.slice(dotIndex + 1).toLowerCase();
};

export const isImageAssetPath = (path: string | null | undefined): boolean =>
  IMAGE_EXTENSIONS.has(getFileExtension(path));

export const isShellScriptPath = (path: string | null | undefined): boolean =>
  SHELL_SCRIPT_EXTENSIONS.has(getFileExtension(path));

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * 将字节数格式化为人类可读的字符串，按 1024 级联覆盖 B ~ PB。
 * 精度规则：scaled < 10 时保留 1 位小数，否则取整。
 */
export const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }

  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exponent;
  return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${BYTE_UNITS[exponent]}`;
};
