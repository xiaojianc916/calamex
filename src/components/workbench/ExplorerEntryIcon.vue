<template>
  <span class="explorer-entry-icon" :style="iconStyle" aria-hidden="true">
    <svg
      v-if="kind === 'directory' && expanded"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 10h18l-2 8a2 2 0 0 1-2 1.5H5A2 2 0 0 1 3 18z" />
    </svg>

    <svg
      v-else-if="kind === 'directory'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>

    <svg
      v-else-if="iconTone === 'rust'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <circle cx="12" cy="15" r="2" />
    </svg>

    <svg
      v-else-if="iconTone === 'config'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>

    <svg
      v-else-if="iconTone === 'document'"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </svg>

    <svg
      v-else
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10 13 8.5 15 10 17" />
      <path d="M14 13 15.5 15 14 17" />
    </svg>
  </span>
</template>

<script setup lang="ts">
import { isImageAssetPath } from '@/utils/file-assets';
import type { CSSProperties } from 'vue';
import { computed } from 'vue';

type TEntryKind = 'file' | 'directory';
type TIconTone = 'folder' | 'rust' | 'config' | 'document' | 'code';

const props = withDefaults(
  defineProps<{
    kind: TEntryKind;
    path?: string | null;
    expanded?: boolean;
  }>(),
  {
    path: null,
    expanded: false,
  },
);

const RUST_EXTENSIONS = new Set(['rs']);
const CONFIG_EXTENSIONS = new Set([
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'config',
  'lock',
]);
const DOCUMENT_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rtf']);
const CONFIG_FILENAMES = new Set([
  '.editorconfig',
  '.env',
  '.eslintrc',
  '.gitattributes',
  '.gitignore',
  '.prettierrc',
  'dockerfile',
  'makefile',
]);

const getFileName = (path: string | null | undefined): string => {
  if (!path) {
    return '';
  }

  const normalizedPath = path.replace(/\\/g, '/');
  const segments = normalizedPath.split('/');
  return (segments[segments.length - 1] ?? '').toLowerCase();
};

const getFileExtension = (path: string | null | undefined): string => {
  const fileName = getFileName(path);
  if (!fileName) {
    return '';
  }

  const extension = fileName.split('.').pop();
  return extension && extension !== fileName ? extension.toLowerCase() : '';
};

const iconTone = computed<TIconTone>(() => {
  if (props.kind === 'directory') {
    return 'folder';
  }

  if (isImageAssetPath(props.path)) {
    return 'code';
  }

  const fileName = getFileName(props.path);
  const extension = getFileExtension(props.path);

  if (RUST_EXTENSIONS.has(extension)) {
    return 'rust';
  }

  if (
    extension === 'vue' ||
    extension === 'ts' ||
    extension === 'tsx' ||
    extension === 'js' ||
    extension === 'jsx'
  ) {
    return 'code';
  }

  if (fileName === '.env' || fileName.startsWith('.env.') || CONFIG_FILENAMES.has(fileName)) {
    return 'config';
  }

  if (CONFIG_EXTENSIONS.has(extension)) {
    return 'config';
  }

  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return 'document';
  }

  return 'code';
});

const iconColor = computed((): string => {
  switch (iconTone.value) {
    case 'folder':
      return '#e0a458';
    case 'rust':
      return '#d97757';
    case 'config':
      return '#b794f6';
    case 'document':
      return '#4ade80';
    default:
      return '#60a5fa';
  }
});

const iconStyle = computed<CSSProperties>(() => ({
  color: iconColor.value,
}));
</script>