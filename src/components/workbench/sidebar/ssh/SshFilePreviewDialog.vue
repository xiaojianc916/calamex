<script setup lang="ts">
import {
  ChevronDown,
  ChevronUp,
  Clock3,
  Copy,
  CornerDownLeft,
  Download,
  HardDrive,
  IndentIncrease,
  Languages,
  ListOrdered,
  MapPin,
  PencilLine,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Terminal,
  TextWrap,
  UserRound,
  X,
} from '@lucide/vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import {
  type ComponentPublicInstance,
  type CSSProperties,
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import {
  createRawTokens,
  highlightCode,
  type ITokenizedCode,
} from '@/components/ai-elements/code-block/utils';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { useMessage } from '@/composables/useMessage';
import { light as lightThemeRoles } from '@/themes/variants/light';
import type { ISshFileItem } from '@/types/ssh';
import type { ISshFileReadPayload } from '@/types/tauri';
import { writeClipboardText } from '@/utils/clipboard';
import {
  buildSshPreviewMatchHits,
  countSshPreviewLines,
  estimateSshPreviewByteSize,
  formatSshPreviewEncoding,
  formatSshPreviewLineEnding,
  formatSshPreviewModifiedAt,
  normalizeSshPreviewContent,
  resolveSshPreviewCursorPosition,
  resolveSshPreviewLanguageInfo,
  type TSshPreviewEncoding,
  type TSshPreviewLineEnding,
} from '@/utils/ssh-file-preview';
import { splitTextGraphemes } from '@/utils/text-preview';
import {
  buildRenderedLineSegments,
  formatRemoteFileSize,
  type IIndexedPreviewMatchHit,
  type IRenderedPreviewLine,
  type TSshPreviewThemeStyle,
} from './ssh-file-preview-render';

const props = defineProps<{
  fileItem: ISshFileItem;
  payload: ISshFileReadPayload | null;
  isLoading: boolean;
  isSaving: boolean;
}>();

const emit = defineEmits<{
  close: [];
  reload: [];
  download: [];
  save: [content: string];
}>();

const message = useMessage();
const searchInputRef = ref<HTMLInputElement | null>(null);
const editorRef = ref<HTMLTextAreaElement | null>(null);
const codeViewportRef = ref<HTMLElement | null>(null);
const editorScrollLeft = ref(0);
const editorScrollTop = ref(0);
const isSearchOpen = ref(false);
const isWrapped = ref(false);
const isEditing = ref(false);
const draftContent = ref('');
const searchQuery = ref('');
const activeHitIndex = ref(-1);
const cursorPosition = ref({ line: 1, column: 1 });

const previewContent = computed(() =>
  props.payload ? normalizeSshPreviewContent(props.payload.content) : '',
);
const currentContent = computed(() =>
  isEditing.value ? draftContent.value : previewContent.value,
);
const currentContentLines = computed(() => currentContent.value.split('\n'));
const languageInfo = computed(() => resolveSshPreviewLanguageInfo(props.fileItem.path));
const encodingLabel = computed(() =>
  props.payload ? formatSshPreviewEncoding(props.payload.encoding as TSshPreviewEncoding) : '—',
);
const lineEndingLabel = computed(() =>
  props.payload
    ? formatSshPreviewLineEnding(props.payload.lineEnding as TSshPreviewLineEnding)
    : '—',
);
const modifiedAtLabel = computed(() =>
  props.payload ? formatSshPreviewModifiedAt(props.payload.modifiedAt) : '—',
);
const lineCountLabel = computed(() =>
  props.payload ? String(countSshPreviewLines(currentContent.value)) : '—',
);
const byteSizeLabel = computed(() => {
  if (!props.payload) {
    return '—';
  }

  return formatRemoteFileSize(
    estimateSshPreviewByteSize(
      currentContent.value,
      props.payload.encoding as TSshPreviewEncoding,
      props.payload.lineEnding as TSshPreviewLineEnding,
    ),
  );
});
const hasUnsavedChanges = computed(
  () => isEditing.value && currentContent.value !== previewContent.value,
);
const statusLabel = computed(() => {
  if (props.isSaving) {
    return '保存中…';
  }
  if (isEditing.value) {
    return hasUnsavedChanges.value ? '编辑中 · 未保存' : '编辑中';
  }

  return '只读预览';
});
const canReload = computed(() => !props.isLoading && !props.isSaving);
const canDownload = computed(
  () => Boolean(props.payload) && !props.isSaving && !hasUnsavedChanges.value,
);
const canCopy = computed(() => Boolean(props.payload) && !props.isLoading);
const canToggleEdit = computed(() => Boolean(props.payload) && !props.isLoading && !props.isSaving);
const canSave = computed(
  () => Boolean(props.payload) && !props.isLoading && !props.isSaving && hasUnsavedChanges.value,
);
const canClose = computed(() => !props.isSaving);
const canSearch = computed(() => Boolean(props.payload) && !props.isLoading);
const canOpenSearch = computed(() => canSearch.value && !props.isSaving);
const normalizedSearchQuery = computed(() => searchQuery.value.trim());
const indexedHits = computed<IIndexedPreviewMatchHit[]>(() =>
  buildSshPreviewMatchHits(currentContent.value, normalizedSearchQuery.value).map(
    (hit, globalIndex) => ({
      ...hit,
      globalIndex,
    }),
  ),
);
const hitsByLine = computed(() => {
  const map = new Map<number, IIndexedPreviewMatchHit[]>();

  for (const hit of indexedHits.value) {
    const lineHits = map.get(hit.lineIndex);
    if (lineHits) {
      lineHits.push(hit);
      continue;
    }

    map.set(hit.lineIndex, [hit]);
  }

  return map;
});
const findCountLabel = computed(() => {
  if (indexedHits.value.length === 0 || activeHitIndex.value < 0) {
    return '0 / 0';
  }

  return `${activeHitIndex.value + 1} / ${indexedHits.value.length}`;
});

const tokenized = ref<ITokenizedCode>(
  highlightCode(currentContent.value, languageInfo.value.codeMirrorLanguage) ??
    createRawTokens(currentContent.value),
);

watch(
  () => props.fileItem.path,
  () => {
    isSearchOpen.value = false;
    isEditing.value = false;
    searchQuery.value = '';
    activeHitIndex.value = -1;
    editorScrollLeft.value = 0;
    editorScrollTop.value = 0;
    cursorPosition.value = { line: 1, column: 1 };
  },
  { immediate: true },
);

watch(
  () => props.payload,
  (payload) => {
    draftContent.value = payload ? normalizeSshPreviewContent(payload.content) : '';
    isEditing.value = false;
    editorScrollLeft.value = 0;
    editorScrollTop.value = 0;
    cursorPosition.value = { line: 1, column: 1 };
  },
  { immediate: true },
);

watch(
  () => [currentContent.value, languageInfo.value.codeMirrorLanguage] as const,
  ([code, language]) => {
    tokenized.value = highlightCode(code, language) ?? createRawTokens(code);

    void Promise.resolve().then(() => {
      highlightCode(code, language, (result) => {
        if (currentContent.value === code && languageInfo.value.codeMirrorLanguage === language) {
          tokenized.value = result;
        }
      });
    });
  },
  { immediate: true },
);

watch(
  () => [normalizedSearchQuery.value, currentContent.value] as const,
  () => {
    activeHitIndex.value = indexedHits.value.length > 0 ? 0 : -1;
    void nextTick(() => {
      syncActiveMatchPresentation();
    });
  },
  { immediate: true },
);

watch(
  () => activeHitIndex.value,
  () => {
    void nextTick(() => {
      syncActiveMatchPresentation();
    });
  },
);

watch(
  () => isSearchOpen.value,
  (open) => {
    if (!open) {
      return;
    }

    void nextTick(() => {
      searchInputRef.value?.focus();
      searchInputRef.value?.select();
    });
  },
);

watch(
  () => isEditing.value,
  (editing) => {
    if (!editing) {
      return;
    }

    void nextTick(() => {
      editorRef.value?.focus();
      syncEditorScroll();
      updateCursorFromEditor();
    });
  },
);

const renderedLines = computed<IRenderedPreviewLine[]>(() =>
  currentContentLines.value.map((line, lineIndex) => ({
    key: `preview-line-${lineIndex}`,
    lineIndex,
    segments: buildRenderedLineSegments(
      tokenized.value.tokens[lineIndex] ?? [],
      line,
      hitsByLine.value.get(lineIndex) ?? [],
      activeHitIndex.value,
    ),
  })),
);

// —— 只读预览虚拟化（复用 @tanstack/vue-virtual）——
// 仅当行数超过阈值时启用：小文件保持原生整体渲染，不影响文本选择与编辑态浮层。
// 采用「顶/底占位块 + 普通文档流」方案，避免破坏水平滚动、sticky 行号槽与网格对齐。
const PREVIEW_VIRTUALIZE_THRESHOLD = 500;
const previewGridRef = ref<HTMLElement | null>(null);
const previewScrollMargin = ref(0);
const shouldVirtualizePreview = computed(
  () => !isEditing.value && renderedLines.value.length > PREVIEW_VIRTUALIZE_THRESHOLD,
);

const previewVirtualizerOptions = computed(() => ({
  count: renderedLines.value.length,
  getScrollElement: (): HTMLElement | null =>
    shouldVirtualizePreview.value ? codeViewportRef.value : null,
  estimateSize: () => 21,
  overscan: 16,
  scrollMargin: previewScrollMargin.value,
  getItemKey: (index: number): string => renderedLines.value[index]?.key ?? String(index),
}));
const previewVirtualizer = useVirtualizer<HTMLElement, HTMLElement>(previewVirtualizerOptions);
const previewTotalSize = computed(() => previewVirtualizer.value.getTotalSize());

const windowedPreviewLines = computed<IRenderedPreviewLine[]>(() => {
  if (!shouldVirtualizePreview.value) {
    return renderedLines.value;
  }

  const lines = renderedLines.value;
  const result: IRenderedPreviewLine[] = [];
  for (const item of previewVirtualizer.value.getVirtualItems()) {
    const line = lines[item.index];
    if (line) {
      result.push(line);
    }
  }
  return result;
});

const previewPaddingTop = computed(() => {
  if (!shouldVirtualizePreview.value) {
    return 0;
  }
  const items = previewVirtualizer.value.getVirtualItems();
  return items.length > 0 ? (items[0]?.start ?? 0) - previewScrollMargin.value : 0;
});

const previewPaddingBottom = computed(() => {
  if (!shouldVirtualizePreview.value) {
    return 0;
  }
  const items = previewVirtualizer.value.getVirtualItems();
  if (items.length === 0) {
    return 0;
  }
  const lastItem = items[items.length - 1];
  const lastEnd = (lastItem?.start ?? 0) + (lastItem?.size ?? 0);
  return Math.max(0, previewTotalSize.value - lastEnd + previewScrollMargin.value);
});

const measurePreviewRow = (el: Element | ComponentPublicInstance | null): void => {
  if (shouldVirtualizePreview.value && el instanceof HTMLElement) {
    previewVirtualizer.value.measureElement(el);
  }
};

const recomputePreviewScrollMargin = (): void => {
  const scroller = codeViewportRef.value;
  const grid = previewGridRef.value;
  if (!scroller || !grid) {
    previewScrollMargin.value = 0;
    return;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const gridRect = grid.getBoundingClientRect();
  previewScrollMargin.value = gridRect.top - scrollerRect.top + scroller.scrollTop;
};

watch(
  () => [shouldVirtualizePreview.value, props.isLoading, renderedLines.value.length] as const,
  () => {
    void nextTick(recomputePreviewScrollMargin);
  },
);

const previewFileIcon = computed(() =>
  languageInfo.value.codeMirrorLanguage === 'text' ? 'file-text' : 'file-code-2',
);
const editorHighlightStyle = computed<CSSProperties>(() => ({
  transform: `translate(${-editorScrollLeft.value}px, ${-editorScrollTop.value}px)`,
}));
const editorGutterStyle = computed<CSSProperties>(() => ({
  transform: `translateY(${-editorScrollTop.value}px)`,
}));
const previewThemeStyle = computed<TSshPreviewThemeStyle>(() => ({
  '--ssh-preview-background': lightThemeRoles.surface.app,
  '--ssh-preview-panel': lightThemeRoles.surface.panel,
  '--ssh-preview-panel-soft': lightThemeRoles.surface.sidebar,
  '--ssh-preview-hover': lightThemeRoles.surface.hover,
  '--ssh-preview-active': lightThemeRoles.surface.softStrong,
  '--ssh-preview-selection': lightThemeRoles.surface.selection,
  '--ssh-preview-border': lightThemeRoles.border.divider,
  '--ssh-preview-border-strong': lightThemeRoles.border.strong,
  '--ssh-preview-text-primary': lightThemeRoles.text.primary,
  '--ssh-preview-text-secondary': lightThemeRoles.text.secondary,
  '--ssh-preview-text-tertiary': lightThemeRoles.text.tertiary,
  '--ssh-preview-text-quaternary': lightThemeRoles.text.quaternary,
  '--ssh-preview-accent': lightThemeRoles.accent.strong,
  '--ssh-preview-accent-muted': lightThemeRoles.accent.muted,
  '--ssh-preview-accent-foreground': lightThemeRoles.text.onAccent,
  '--ssh-preview-success': lightThemeRoles.status.success,
  '--ssh-preview-warning': lightThemeRoles.status.warningMuted,
}));

function focusSearch(): void {
  if (!canOpenSearch.value) {
    return;
  }

  isSearchOpen.value = true;
}

function closeSearch(): void {
  isSearchOpen.value = false;
  searchQuery.value = '';
  activeHitIndex.value = -1;
}

function stepSearchHit(direction: 1 | -1): void {
  if (indexedHits.value.length === 0) {
    return;
  }

  if (activeHitIndex.value < 0) {
    activeHitIndex.value = 0;
    return;
  }

  activeHitIndex.value =
    (activeHitIndex.value + direction + indexedHits.value.length) % indexedHits.value.length;
}

function syncActiveMatchPresentation(): void {
  if (activeHitIndex.value < 0 || indexedHits.value.length === 0) {
    return;
  }

  if (isEditing.value) {
    selectActiveHitInEditor();
    return;
  }

  const scrollActiveHitIntoView = (): void => {
    const activeElement = codeViewportRef.value?.querySelector<HTMLElement>(
      '[data-ssh-preview-active-hit="true"]',
    );
    activeElement?.scrollIntoView({
      block: 'center',
      inline: 'nearest',
    });
  };

  const activeHit = indexedHits.value[activeHitIndex.value];
  if (shouldVirtualizePreview.value && activeHit) {
    // 命中行可能尚未渲染：先把它滚进窗口，再做精确的水平对齐。
    previewVirtualizer.value.scrollToIndex(activeHit.lineIndex, { align: 'center' });
    void nextTick(scrollActiveHitIntoView);
  } else {
    scrollActiveHitIntoView();
  }
}

function selectActiveHitInEditor(): void {
  const activeHit = indexedHits.value[activeHitIndex.value];
  const editor = editorRef.value;
  if (!activeHit || !editor) {
    return;
  }

  editor.focus();
  editor.setSelectionRange(activeHit.globalStart, activeHit.globalEnd);
  updateCursorFromEditor(editor);

  const lineHeight = Number.parseFloat(window.getComputedStyle(editor).lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    const targetTop = activeHit.lineIndex * lineHeight - editor.clientHeight / 2 + lineHeight;
    editor.scrollTop = Math.max(0, targetTop);
    syncEditorScroll(editor);
  }
}

function updateCursorFromEditor(target = editorRef.value): void {
  if (!target) {
    return;
  }

  const beforeCursor = target.value.slice(0, target.selectionStart);
  cursorPosition.value = resolveSshPreviewCursorPosition(beforeCursor);
}

function syncEditorScroll(target = editorRef.value): void {
  if (!target) {
    return;
  }

  editorScrollLeft.value = target.scrollLeft;
  editorScrollTop.value = target.scrollTop;
}

function handleEditorScroll(): void {
  syncEditorScroll();
  updateCursorFromEditor();
}

function updateCursorFromPreviewSelection(): void {
  const selection = window.getSelection();
  if (!selection?.anchorNode) {
    return;
  }

  const anchorElement =
    selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
  const lineElement = anchorElement?.closest<HTMLElement>('[data-ssh-preview-line-index]');
  const codeElement = lineElement?.querySelector<HTMLElement>('[data-ssh-preview-line-code]');
  if (!lineElement || !codeElement) {
    return;
  }
  if (!codeViewportRef.value?.contains(codeElement)) {
    return;
  }

  const lineIndex = Number.parseInt(lineElement.dataset.sshPreviewLineIndex ?? '0', 10);
  if (!Number.isFinite(lineIndex)) {
    return;
  }

  const range = document.createRange();
  try {
    range.setStart(codeElement, 0);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
  } catch {
    return;
  }

  cursorPosition.value = {
    line: lineIndex + 1,
    column: splitTextGraphemes(range.toString()).length + 1,
  };
}

async function requestCopy(): Promise<void> {
  if (!canCopy.value) {
    return;
  }

  try {
    await writeClipboardText(currentContent.value);
    message.success('已复制到剪贴板');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : '复制失败。';
    message.error(errorMessage);
  }
}

function openEditMode(): void {
  if (!canToggleEdit.value) {
    return;
  }

  draftContent.value = previewContent.value;
  editorScrollLeft.value = 0;
  editorScrollTop.value = 0;
  isEditing.value = true;
}

function requestSave(): void {
  if (!canSave.value) {
    return;
  }

  emit('save', draftContent.value);
}

function cancelEditMode(): void {
  if (!isEditing.value || props.isSaving) {
    return;
  }

  if (hasUnsavedChanges.value && !window.confirm('当前修改尚未保存，确定放弃这些更改吗？')) {
    return;
  }

  draftContent.value = previewContent.value;
  editorScrollLeft.value = 0;
  editorScrollTop.value = 0;
  isEditing.value = false;
  cursorPosition.value = { line: 1, column: 1 };
}

function requestReload(): void {
  if (!canReload.value) {
    return;
  }

  if (hasUnsavedChanges.value && !window.confirm('重新加载会丢失未保存的修改，确定继续吗？')) {
    return;
  }

  emit('reload');
}

function requestDownload(): void {
  if (!canDownload.value) {
    if (hasUnsavedChanges.value) {
      message.info('请先保存当前修改，再下载远端文件。');
    }
    return;
  }

  emit('download');
}

function requestClose(): void {
  if (!canClose.value) {
    return;
  }

  if (hasUnsavedChanges.value && !window.confirm('关闭预览会丢失未保存的修改，确定继续吗？')) {
    return;
  }

  emit('close');
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (isSearchOpen.value) {
      closeSearch();
      return;
    }
    requestClose();
    return;
  }

  const isMetaPressed = event.metaKey || event.ctrlKey;
  if (!isMetaPressed) {
    return;
  }

  if (event.key.toLowerCase() === 'f') {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (event.key.toLowerCase() === 'r') {
    event.preventDefault();
    requestReload();
    return;
  }

  if (event.key.toLowerCase() === 'e' && !isEditing.value) {
    event.preventDefault();
    openEditMode();
    return;
  }

  if (event.key.toLowerCase() === 's' && isEditing.value) {
    event.preventDefault();
    requestSave();
  }
}

function handleSearchInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    stepSearchHit(event.shiftKey ? -1 : 1);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    closeSearch();
  }
}

function handlePreviewMouseUp(): void {
  updateCursorFromPreviewSelection();
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
  void nextTick(recomputePreviewScrollMargin);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="ssh-preview-dialog__scrim" :style="previewThemeStyle" @click.self="requestClose">
      <section class="ssh-preview-dialog" role="dialog" aria-modal="true" aria-label="SSH 文件预览">
        <header class="ssh-preview-dialog__header">
          <div class="ssh-preview-dialog__file-icon" aria-hidden="true">
            <LucideIcon :name="previewFileIcon" class="size-4" />
          </div>

          <div class="ssh-preview-dialog__title-group">
            <div class="ssh-preview-dialog__filename"> props.fileItem.name </div>
            <div class="ssh-preview-dialog__filepath"> props.fileItem.path </div>
          </div>

          <div class="ssh-preview-dialog__actions">
            <button type="button" class="ssh-preview-dialog__icon-button" :disabled="!canOpenSearch"
              title="搜索 (Ctrl/Cmd + F)" aria-label="搜索" @click="focusSearch">
              <Search aria-hidden="true" />
            </button>
            <button type="button" class="ssh-preview-dialog__icon-button" :title="isWrapped ? '关闭自动换行' : '开启自动换行'"
              :aria-label="isWrapped ? '关闭自动换行' : '开启自动换行'" @click="isWrapped = !isWrapped">
              <TextWrap aria-hidden="true" />
            </button>
            <button type="button" class="ssh-preview-dialog__icon-button" :disabled="!canReload"
              title="重新加载 (Ctrl/Cmd + R)" aria-label="重新加载" @click="requestReload">
              <RefreshCw aria-hidden="true" />
            </button>

            <span class="ssh-preview-dialog__divider" aria-hidden="true" />

            <button type="button" class="ssh-preview-dialog__action-button" :disabled="!canCopy" @click="requestCopy">
              <Copy aria-hidden="true" />
              <span>复制</span>
            </button>
            <button type="button" class="ssh-preview-dialog__action-button" :disabled="!canDownload"
              @click="requestDownload">
              <Download aria-hidden="true" />
              <span>下载</span>
            </button>
            <button v-if="isEditing" type="button" class="ssh-preview-dialog__action-button" :disabled="props.isSaving"
              @click="cancelEditMode">
              <X aria-hidden="true" />
              <span>取消编辑</span>
            </button>
            <button v-if="isEditing" type="button"
              class="ssh-preview-dialog__action-button ssh-preview-dialog__action-button--primary" :disabled="!canSave"
              @click="requestSave">
              <Save aria-hidden="true" />
              <span> props.isSaving ? '保存中…' : '保存' </span>
            </button>
            <button v-else type="button"
              class="ssh-preview-dialog__action-button ssh-preview-dialog__action-button--primary"
              :disabled="!canToggleEdit" @click="openEditMode">
              <PencilLine aria-hidden="true" />
              <span>编辑</span>
            </button>

            <span class="ssh-preview-dialog__divider" aria-hidden="true" />

            <button type="button" class="ssh-preview-dialog__icon-button" :disabled="!canClose" title="关闭 (Esc)"
              aria-label="关闭" @click="requestClose">
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div class="ssh-preview-dialog__meta">
          <span class="ssh-preview-dialog__meta-item">
            <HardDrive aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">大小</span>
            <b> byteSizeLabel </b>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <ListOrdered aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">行数</span>
            <b> lineCountLabel </b>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <Languages aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">编码</span>
            <span class="ssh-preview-dialog__badge"> encodingLabel </span>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <CornerDownLeft aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">换行</span>
            <span class="ssh-preview-dialog__badge"> lineEndingLabel </span>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <ShieldCheck aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">权限</span>
            <span class="ssh-preview-dialog__mono"> props.payload?.permission ?? '—' </span>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <UserRound aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">所有者</span>
            <b> props.payload?.owner ?? '—' </b>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <Clock3 aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">修改</span>
            <b> modifiedAtLabel </b>
          </span>

          <span class="ssh-preview-dialog__status" :class="{ 'is-editing': isEditing }">
             statusLabel 
          </span>
        </div>

        <div class="ssh-preview-dialog__toolbar" :class="{ 'is-open': isSearchOpen }">
          <div class="ssh-preview-dialog__search">
            <Search aria-hidden="true" />
            <input ref="searchInputRef" v-model="searchQuery" type="text" placeholder="在文件中查找…" autocomplete="off"
              @keydown="handleSearchInputKeydown">
            <span class="ssh-preview-dialog__search-count"> findCountLabel </span>
          </div>

          <button type="button" class="ssh-preview-dialog__icon-button" :disabled="indexedHits.length === 0"
            aria-label="上一处" @click="stepSearchHit(-1)">
            <ChevronUp aria-hidden="true" />
          </button>
          <button type="button" class="ssh-preview-dialog__icon-button" :disabled="indexedHits.length === 0"
            aria-label="下一处" @click="stepSearchHit(1)">
            <ChevronDown aria-hidden="true" />
          </button>
          <button type="button" class="ssh-preview-dialog__icon-button" aria-label="关闭搜索" @click="closeSearch">
            <X aria-hidden="true" />
          </button>
        </div>

        <div ref="codeViewportRef" class="ssh-preview-dialog__code" :class="{ 'is-wrapped': isWrapped }">
          <div v-if="props.isLoading && !props.payload" class="ssh-preview-dialog__state" aria-live="polite">
            正在读取远端文件…
          </div>

          <template v-else-if="props.payload">
            <div v-if="props.isLoading" class="ssh-preview-dialog__loading-pill" aria-live="polite">
              正在重新加载…
            </div>

            <div v-if="isEditing" class="ssh-preview-dialog__editor-grid">
              <div class="ssh-preview-dialog__gutter ssh-preview-dialog__editor-gutter" aria-hidden="true">
                <div class="ssh-preview-dialog__editor-gutter-lines" :style="editorGutterStyle">
                  <span v-for="lineIndex in currentContentLines.length" :key="`editor-line-${lineIndex}`">
                     lineIndex 
                  </span>
                </div>
              </div>

              <div class="ssh-preview-dialog__editor-shell">
                <div class="ssh-preview-dialog__editor-highlight" :style="editorHighlightStyle" aria-hidden="true">
                  <div v-for="line in renderedLines" :key="`editor-highlight-${line.key}`"
                    class="ssh-preview-dialog__line-code ssh-preview-dialog__line-code--editor"
                    data-ssh-preview-line-code="true">
                    <template v-if="line.segments.length === 0">
                      <span class="ssh-preview-dialog__empty-line">&nbsp;</span>
                    </template>

                    <template v-else>
                      <span v-for="segment in line.segments" :key="segment.key" class="ssh-preview-dialog__segment"
                        :class="{
                          'is-match': segment.matched,
                          'is-active-match': segment.active,
                        }" :data-ssh-preview-active-hit="segment.active ? 'true' : undefined" :style="segment.style">
                         segment.text 
                      </span>
                    </template>
                  </div>
                </div>

                <textarea ref="editorRef" v-model="draftContent" class="ssh-preview-dialog__editor"
                  :class="{ 'is-wrapped': isWrapped }" :wrap="isWrapped ? 'soft' : 'off'" spellcheck="false"
                  @click="updateCursorFromEditor()" @keyup="updateCursorFromEditor()" @select="updateCursorFromEditor()"
                  @scroll.passive="handleEditorScroll" />
              </div>
            </div>

            <div v-else ref="previewGridRef" class="ssh-preview-dialog__preview-grid" @mouseup="handlePreviewMouseUp">
              <div v-if="shouldVirtualizePreview" :style="{ height: `${previewPaddingTop}px` }" aria-hidden="true" />

              <div v-for="line in windowedPreviewLines" :key="line.key" :ref="measurePreviewRow"
                :data-index="line.lineIndex" class="ssh-preview-dialog__line"
                :data-ssh-preview-line-index="line.lineIndex">
                <div class="ssh-preview-dialog__gutter" aria-hidden="true">
                  <span>  line.lineIndex + 1  </span>
                </div>

                <div class="ssh-preview-dialog__line-code" data-ssh-preview-line-code="true">
                  <template v-if="line.segments.length === 0">
                    <span class="ssh-preview-dialog__empty-line">&nbsp;</span>
                  </template>

                  <template v-else>
                    <span v-for="segment in line.segments" :key="segment.key" class="ssh-preview-dialog__segment"
                      :class="{
                        'is-match': segment.matched,
                        'is-active-match': segment.active,
                      }" :data-ssh-preview-active-hit="segment.active ? 'true' : undefined" :style="segment.style">  segment.text  </span>
                  </template>
                </div>
              </div>

              <div v-if="shouldVirtualizePreview" :style="{ height: `${previewPaddingBottom}px` }" aria-hidden="true" />
            </div>
          </template>
        </div>

        <footer class="ssh-preview-dialog__footer">
          <span class="ssh-preview-dialog__footer-segment">
            <Terminal aria-hidden="true" />
            <span> languageInfo.label </span>
          </span>
          <span class="ssh-preview-dialog__footer-segment">
            <MapPin aria-hidden="true" />
            <b>行  cursorPosition.line , 列  cursorPosition.column </b>
          </span>

          <div class="ssh-preview-dialog__footer-spacer" />

          <button type="button" class="ssh-preview-dialog__footer-segment ssh-preview-dialog__footer-segment--button"
            @click="isWrapped = !isWrapped">
            <TextWrap aria-hidden="true" />
            <span>换行  isWrapped ? '开' : '关' </span>
          </button>
          <span class="ssh-preview-dialog__footer-segment">
            <IndentIncrease aria-hidden="true" />
            <span>Tab=2</span>
          </span>
          <span class="ssh-preview-dialog__footer-segment"> encodingLabel </span>
          <span class="ssh-preview-dialog__footer-segment"> lineEndingLabel </span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ssh-preview-dialog__scrim {
  position: fixed;
  inset: 0;
  z-index: 1300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--ssh-preview-background) 58%, transparent);
  backdrop-filter: blur(6px);
}

.ssh-preview-dialog {
  display: flex;
  width: min(920px, calc(100vw - 32px));
  height: min(700px, calc(100vh - 36px));
  min-height: 420px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--ssh-preview-border) 92%, transparent);
  border-radius: calc(var(--radius) + 2px);
  background: var(--ssh-preview-panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ssh-preview-border) 26%, transparent),
    0 24px 60px color-mix(in srgb, var(--ssh-preview-text-primary) 14%, transparent);
}

.ssh-preview-dialog__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--ssh-preview-border) 84%, transparent);
  background: var(--ssh-preview-panel);
}

.ssh-preview-dialog__file-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: calc(var(--radius) - 4px);
  background: color-mix(in srgb, var(--ssh-preview-accent) 12%, var(--ssh-preview-panel));
  color: var(--ssh-preview-accent);
}

.ssh-preview-dialog__file-icon :deep(svg) {
  width: 16px;
  height: 16px;
}

.ssh-preview-dialog__title-group {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 2px;
}

.ssh-preview-dialog__filename {
  min-width: 0;
  overflow: hidden;
  color: var(--ssh-preview-text-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-preview-dialog__filepath {
  min-width: 0;
  overflow: hidden;
  color: var(--ssh-preview-text-tertiary);
  direction: rtl;
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-preview-dialog__actions {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.ssh-preview-dialog__divider {
  width: 1px;
  height: 18px;
  flex: 0 0 auto;
  margin: 0 3px;
  background: color-mix(in srgb, var(--ssh-preview-border) 86%, transparent);
}

.ssh-preview-dialog__icon-button,
.ssh-preview-dialog__action-button,
.ssh-preview-dialog__footer-segment--button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: calc(var(--radius) - 4px);
  background: transparent;
  color: var(--ssh-preview-text-secondary);
  cursor: pointer;
  transition:
    background-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    border-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ssh-preview-dialog__icon-button {
  width: 30px;
  height: 30px;
  padding: 0;
}

.ssh-preview-dialog__action-button {
  height: 30px;
  gap: 6px;
  padding: 0 10px;
  font-size: 12px;
  white-space: nowrap;
}

.ssh-preview-dialog__icon-button:hover:not(:disabled),
.ssh-preview-dialog__action-button:hover:not(:disabled),
.ssh-preview-dialog__footer-segment--button:hover:not(:disabled) {
  background: var(--ssh-preview-hover);
  color: var(--ssh-preview-text-primary);
}

.ssh-preview-dialog__icon-button:active:not(:disabled),
.ssh-preview-dialog__action-button:active:not(:disabled),
.ssh-preview-dialog__footer-segment--button:active:not(:disabled) {
  transform: scale(0.97);
}

.ssh-preview-dialog__icon-button:focus-visible,
.ssh-preview-dialog__action-button:focus-visible,
.ssh-preview-dialog__footer-segment--button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ssh-preview-accent) 42%, transparent);
  outline-offset: 2px;
}

.ssh-preview-dialog__action-button--primary {
  background: var(--ssh-preview-accent);
  color: var(--ssh-preview-accent-foreground);
}

.ssh-preview-dialog__action-button--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ssh-preview-accent) 90%, var(--ssh-preview-text-primary));
  color: var(--ssh-preview-accent-foreground);
}

.ssh-preview-dialog__icon-button:disabled,
.ssh-preview-dialog__action-button:disabled,
.ssh-preview-dialog__footer-segment--button:disabled {
  cursor: default;
  opacity: 0.46;
}

.ssh-preview-dialog__icon-button :deep(svg),
.ssh-preview-dialog__action-button :deep(svg),
.ssh-preview-dialog__meta-item :deep(svg),
.ssh-preview-dialog__footer-segment :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.ssh-preview-dialog__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--ssh-preview-border) 84%, transparent);
  background: var(--ssh-preview-panel);
  color: var(--ssh-preview-text-secondary);
  font-size: 12px;
}

.ssh-preview-dialog__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ssh-preview-dialog__meta-item :deep(svg) {
  color: var(--ssh-preview-text-quaternary);
}

.ssh-preview-dialog__meta-label {
  color: var(--ssh-preview-text-tertiary);
}

.ssh-preview-dialog__meta-item b,
.ssh-preview-dialog__mono {
  color: var(--ssh-preview-text-primary);
  font-size: 11.5px;
  font-weight: 500;
  font-family: var(--font-mono);
}

.ssh-preview-dialog__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: calc(var(--radius) - 7px);
  background: color-mix(in srgb, var(--ssh-preview-hover) 92%, transparent);
  color: var(--ssh-preview-text-secondary);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.ssh-preview-dialog__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: color-mix(in srgb, var(--ssh-preview-success) 80%, var(--ssh-preview-text-primary));
}

.ssh-preview-dialog__status::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
}

.ssh-preview-dialog__status.is-editing {
  color: color-mix(in srgb, var(--ssh-preview-accent) 78%, var(--ssh-preview-text-primary));
}

.ssh-preview-dialog__toolbar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--ssh-preview-border) 82%, transparent);
  background: color-mix(in srgb, var(--ssh-preview-panel) 94%, var(--ssh-preview-panel-soft));
}

.ssh-preview-dialog__toolbar.is-open {
  display: flex;
}

.ssh-preview-dialog__search {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--ssh-preview-border);
  border-radius: calc(var(--radius) - 4px);
  background: color-mix(in srgb, var(--ssh-preview-panel) 98%, transparent);
  padding: 0 10px;
  transition:
    border-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    box-shadow 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ssh-preview-dialog__search:focus-within {
  border-color: color-mix(in srgb, var(--ssh-preview-accent) 70%, var(--ssh-preview-border-strong));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ssh-preview-accent) 16%, transparent);
}

.ssh-preview-dialog__search :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--ssh-preview-text-quaternary);
}

.ssh-preview-dialog__search input {
  width: 100%;
  min-width: 0;
  height: 32px;
  border: 0;
  background: transparent;
  color: var(--ssh-preview-text-primary);
  font-family: var(--font-mono);
  font-size: 12.5px;
  outline: none;
}

.ssh-preview-dialog__search-count {
  flex: 0 0 auto;
  color: var(--ssh-preview-text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.ssh-preview-dialog__code {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: var(--ssh-preview-panel);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ssh-preview-text-quaternary) 56%, transparent) transparent;
}

.ssh-preview-dialog__code::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.ssh-preview-dialog__code::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--ssh-preview-text-quaternary) 54%, transparent);
}

.ssh-preview-dialog__code::-webkit-scrollbar-track {
  background: transparent;
}

.ssh-preview-dialog__state {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: 24px;
  color: var(--ssh-preview-text-secondary);
  font-size: 13px;
}

.ssh-preview-dialog__loading-pill {
  position: sticky;
  top: 12px;
  z-index: 2;
  width: fit-content;
  margin: 12px auto 0;
  border: 1px solid color-mix(in srgb, var(--ssh-preview-accent) 18%, var(--ssh-preview-border));
  border-radius: calc(var(--radius) - 2px);
  background: color-mix(in srgb, var(--ssh-preview-panel) 96%, var(--ssh-preview-background));
  padding: 4px 10px;
  color: var(--ssh-preview-text-secondary);
  font-size: 11.5px;
  backdrop-filter: blur(4px);
}

.ssh-preview-dialog__preview-grid {
  min-width: 100%;
}

.ssh-preview-dialog__line,
.ssh-preview-dialog__editor-grid {
  display: grid;
  grid-template-columns: auto 1fr;
}

.ssh-preview-dialog__editor-grid {
  min-width: 100%;
  height: 100%;
  min-height: 0;
}

.ssh-preview-dialog__gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  display: grid;
  align-content: start;
  min-width: 64px;
  padding: 0 12px 0 18px;
  border-right: 1px solid color-mix(in srgb, var(--ssh-preview-border) 82%, transparent);
  background: var(--ssh-preview-panel);
  color: var(--ssh-preview-text-tertiary);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  text-align: right;
  user-select: none;
}

.ssh-preview-dialog__line .ssh-preview-dialog__gutter {
  padding-top: 0;
  padding-bottom: 0;
}

.ssh-preview-dialog__editor-gutter {
  height: 100%;
  min-height: 0;
  padding-top: 14px;
  padding-bottom: 14px;
  overflow: hidden;
}

.ssh-preview-dialog__editor-gutter-lines {
  position: absolute;
  top: 14px;
  right: 12px;
  left: 18px;
  display: grid;
  align-content: start;
  will-change: transform;
}

.ssh-preview-dialog__line-code,
.ssh-preview-dialog__editor,
.ssh-preview-dialog__editor-highlight {
  min-height: 20px;
  color: var(--ssh-preview-text-primary);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  tab-size: 2;
}

.ssh-preview-dialog__line-code {
  padding: 0 18px;
}

.ssh-preview-dialog__line-code {
  white-space: pre;
}

.ssh-preview-dialog__code.is-wrapped .ssh-preview-dialog__line-code {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.ssh-preview-dialog__segment {
  border-radius: 3px;
}

.ssh-preview-dialog__segment.is-match {
  background: color-mix(in srgb, var(--ssh-preview-warning) 72%, transparent);
}

.ssh-preview-dialog__segment.is-active-match {
  background: color-mix(in srgb, var(--ssh-preview-warning) 92%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ssh-preview-warning) 64%, transparent);
}

.ssh-preview-dialog__empty-line {
  display: inline-block;
  width: 1px;
}

.ssh-preview-dialog__editor-shell {
  position: relative;
  min-width: 0;
  height: 100%;
  min-height: 0;
  background: var(--ssh-preview-panel);
}

.ssh-preview-dialog__editor-highlight {
  position: absolute;
  inset: 0;
  z-index: 0;
  min-width: max-content;
  padding: 14px 18px;
  overflow: hidden;
  pointer-events: none;
  white-space: pre;
  will-change: transform;
}

.ssh-preview-dialog__line-code--editor {
  padding: 0;
}

.ssh-preview-dialog__code.is-wrapped .ssh-preview-dialog__editor-highlight {
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.ssh-preview-dialog__editor {
  position: absolute;
  inset: 0;
  z-index: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 14px 18px;
  border: 0;
  background: transparent;
  color: transparent;
  caret-color: var(--ssh-preview-text-primary);
  resize: none;
  outline: none;
  overflow: auto;
  white-space: pre;
  -webkit-text-fill-color: transparent;
}

.ssh-preview-dialog__editor.is-wrapped {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ssh-preview-dialog__editor::selection {
  background: color-mix(in srgb, var(--ssh-preview-accent) 24%, transparent);
}

.ssh-preview-dialog__footer {
  display: flex;
  align-items: center;
  gap: 8px 10px;
  padding: 8px 14px;
  border-top: 1px solid color-mix(in srgb, var(--ssh-preview-border) 84%, transparent);
  background: color-mix(in srgb, var(--ssh-preview-panel) 94%, var(--ssh-preview-panel-soft));
  color: var(--ssh-preview-text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  flex-wrap: wrap;
}

.ssh-preview-dialog__footer-segment {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: calc(var(--radius) - 6px);
}

.ssh-preview-dialog__footer-segment b {
  color: var(--ssh-preview-text-primary);
  font-weight: 500;
}

.ssh-preview-dialog__footer-segment--button {
  height: 24px;
  padding: 0 7px;
  font: inherit;
}

.ssh-preview-dialog__footer-spacer {
  flex: 1 1 auto;
}

@media (prefers-reduced-motion: reduce) {

  .ssh-preview-dialog,
  .ssh-preview-dialog * {
    transition-duration: 0ms;
    scroll-behavior: auto;
  }
}

@media (max-width: 960px) {
  .ssh-preview-dialog__header {
    align-items: flex-start;
    gap: 10px;
  }

  .ssh-preview-dialog__actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
}

@media (max-width: 720px) {
  .ssh-preview-dialog__scrim {
    padding: 12px;
  }

  .ssh-preview-dialog {
    width: min(100vw - 12px, 920px);
    height: min(100vh - 12px, 700px);
  }

  .ssh-preview-dialog__meta {
    gap: 8px 12px;
  }

  .ssh-preview-dialog__status {
    width: 100%;
    margin-left: 0;
  }
}
</style>
