import type { IAiContextReference } from '@/types/ai';

const MAX_CONTEXT_PREVIEW_CHARS = 4000;

const clipPreview = (value: string): string => {
  const chars = [...value];
  if (chars.length <= MAX_CONTEXT_PREVIEW_CHARS) {
    return value;
  }
  return `${chars.slice(0, MAX_CONTEXT_PREVIEW_CHARS).join('')}\n[已截断]`;
};

const normalizeContextPath = (path: string | null | undefined): string | null => {
  if (typeof path !== 'string') {
    return null;
  }

  return path.trim() ? path : null;
};

export const buildCurrentFileReference = (
  document: IEditorDocument,
): IAiContextReference | null => {
  if (!document.id || document.kind !== 'text') {
    return null;
  }

  const path = normalizeContextPath(document.path);

  return {
    id: `current-file:${path ?? document.id}`,
    kind: 'current-file',
    label: document.name,
    path,
    range: null,
    contentPreview: clipPreview(document.content),
    redacted: false,
  };
};
