import type { IAiAttachedFile } from '@/types/ai';

// ---------------------------------------------------------------------------
// Attachment / image helpers (extracted from useAiAssistant.ts)
// ---------------------------------------------------------------------------

export interface IAiImageDimensions {
  width: number;
  height: number;
}

const TEXT_ATTACHMENT_PATTERN =
  /^(application\/(json|xml|x-sh|x-shellscript|javascript|typescript)|text\/)/i;

const TEXT_ATTACHMENT_EXTENSION_PATTERN =
  /\.(bash|cjs|conf|css|csv|env|js|json|jsx|log|md|mjs|ps1|py|rs|sh|sql|toml|ts|tsx|txt|vue|xml|yaml|yml|zsh)$/i;

const IMAGE_ATTACHMENT_PATTERN = /^image\//i;

const IMAGE_ATTACHMENT_EXTENSION_PATTERN = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;

export const clipText = (value: string, limit: number): string => {
  const chars = [...value];

  if (chars.length <= limit) {
    return value;
  }

  return `${chars.slice(0, limit).join('')}\n\n[内容已截断，仅发送前 ${limit} 个字符]`;
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const isTextAttachment = (file: File): boolean =>
  TEXT_ATTACHMENT_PATTERN.test(file.type) || TEXT_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

export const isImageAttachment = (file: File): boolean =>
  IMAGE_ATTACHMENT_PATTERN.test(file.type) || IMAGE_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

// 文本类附件的规范 MIME（扩展名优先）：浏览器 File.type 对 .ts/.vue/.rs 等常给空或错值，故以
// 扩展名为准，未命中再回退到形似文本的 File.type，最后兜底 text/plain。用作 ACP embedded resource
// 的 mimeType 槽位，供 agent 侧识别语言类型（见 acp/to-runtime-input.ts 渲染抬头）。
const TEXT_ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  vue: 'text/x-vue',
  json: 'application/json',
  md: 'text/markdown',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  sql: 'application/sql',
  toml: 'application/toml',
  css: 'text/css',
  csv: 'text/csv',
  xml: 'application/xml',
  html: 'text/html',
  sh: 'text/x-sh',
  bash: 'text/x-sh',
  zsh: 'text/x-sh',
  txt: 'text/plain',
  log: 'text/plain',
  env: 'text/plain',
  conf: 'text/plain',
  ps1: 'text/plain',
};

export const resolveTextAttachmentMimeType = (file: File): string => {
  const match = /\.([^.]+)$/.exec(file.name.trim().toLowerCase());
  const byExtension = match ? TEXT_ATTACHMENT_MIME_BY_EXTENSION[match[1]] : undefined;

  if (byExtension) {
    return byExtension;
  }

  const declared = file.type.trim().toLowerCase();

  if (declared && TEXT_ATTACHMENT_PATTERN.test(declared)) {
    return declared;
  }

  return 'text/plain';
};

const inferImageExtension = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase();

  if (normalized === 'image/jpeg') {
    return 'jpg';
  }

  if (normalized === 'image/svg+xml') {
    return 'svg';
  }

  if (normalized.startsWith('image/')) {
    return normalized.slice('image/'.length);
  }

  return 'png';
};

const createAttachmentContentHash = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let hash = 0x811c9dc5;

  bytes.forEach((byte) => {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  });

  return hash.toString(36).padStart(7, '0');
};

export const createImageAttachmentSignature = async (file: File): Promise<string> => {
  const buffer = await file.arrayBuffer().catch((): null => null);

  if (!buffer) {
    return `image:${file.type || 'image/*'}:${file.name.trim()}:${file.lastModified}:${file.size}`;
  }

  return `image:${file.type || 'image/*'}:${file.size}:${createAttachmentContentHash(buffer)}`;
};

const splitAttachmentFileName = (fileName: string): { baseName: string; extension: string } => {
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return {
      baseName: fileName,
      extension: '',
    };
  }

  return {
    baseName: fileName.slice(0, dotIndex),
    extension: fileName.slice(dotIndex),
  };
};

const createAttachmentNameKey = (fileName: string): string => fileName.normalize('NFC');

export const createUniqueAttachmentName = (
  preferredName: string,
  existingFiles: readonly IAiAttachedFile[],
): string => {
  const usedNames = new Set(existingFiles.map((file) => createAttachmentNameKey(file.name)));

  if (!usedNames.has(createAttachmentNameKey(preferredName))) {
    return preferredName;
  }

  const { baseName, extension } = splitAttachmentFileName(preferredName);
  let index = 1;
  let nextName = `${baseName}${index}${extension}`;

  while (usedNames.has(createAttachmentNameKey(nextName))) {
    index += 1;
    nextName = `${baseName}${index}${extension}`;
  }

  return nextName;
};

export const normalizeAttachmentName = (file: File): string => {
  const normalizedName = file.name.trim();

  if (normalizedName) {
    return normalizedName;
  }

  if (isImageAttachment(file)) {
    return `pasted-image.${inferImageExtension(file.type)}`;
  }

  return 'pasted-attachment.txt';
};

export const formatImageDimensions = (dimensions: IAiImageDimensions | null): string | null => {
  if (!dimensions) {
    return null;
  }

  return `${dimensions.width} × ${dimensions.height}`;
};

const readFileAsDataUrl = async (file: File): Promise<string | null> => {
  if (typeof FileReader === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();

    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);

    reader.readAsDataURL(file);
  });
};

export const createImagePreviewSource = async (file: File): Promise<string | null> => {
  return readFileAsDataUrl(file);
};

const readImageDimensionsFromSource = async (
  source: string,
): Promise<IAiImageDimensions | null> => {
  if (typeof Image === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    const image = new Image();

    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
    };

    image.onload = () => {
      cleanup();
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    };

    image.onerror = () => {
      cleanup();
      resolve(null);
    };

    image.src = source;
  });
};

export const readImageDimensions = async (
  file: File,
  fallbackSource?: string | null,
): Promise<IAiImageDimensions | null> => {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file);

      const dimensions = {
        width: bitmap.width,
        height: bitmap.height,
      };

      bitmap.close?.();

      return dimensions;
    } catch {
      // Ignore and continue with element-based fallback below.
    }
  }

  if (!fallbackSource) {
    return null;
  }

  return readImageDimensionsFromSource(fallbackSource);
};
