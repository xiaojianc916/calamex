import type { ISshPathSegment, TSshFileKind } from '@/types/ssh';

export const quoteShellArg = (value: string): string => {
  const normalizedValue = value.trim();
  if (/^[a-zA-Z0-9_@%+=:,./~-]+$/.test(normalizedValue)) {
    return normalizedValue;
  }
  return `'${normalizedValue.replace(/'/g, "'\\''")}'`;
};

export const formatRemoteFileSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

export const resolveFileKind = (name: string, isDirectory: boolean): TSshFileKind => {
  if (isDirectory) return 'folder';
  if (name.endsWith('.rs')) return 'rust';
  if (name.endsWith('.toml')) return 'toml';
  if (name.endsWith('.md')) return 'markdown';
  if (name.toLowerCase().endsWith('lock')) return 'lock';
  return 'file';
};

export const buildRemotePathSegments = (path: string): ISshPathSegment[] => {
  const normalizedPath = path.trim() || '.';
  if (normalizedPath === '.') {
    return [{ id: '.', label: '.', path: '.' }];
  }

  const segments: ISshPathSegment[] = [];
  const isAbsolutePath = normalizedPath.startsWith('/');
  const parts = normalizedPath.split('/').filter(Boolean);
  let cursor = '';

  if (isAbsolutePath) {
    segments.push({ id: '/', label: '/', path: '/' });
  }

  for (const part of parts) {
    cursor = cursor ? `${cursor}/${part}` : isAbsolutePath ? `/${part}` : part;
    segments.push({ id: cursor, label: part, path: cursor });
  }

  return segments.length > 0 ? segments : [{ id: '.', label: '.', path: '.' }];
};
