<script setup lang="ts">
import { createRawTokens, highlightCode, isBold, isItalic, isUnderline, type ITokenizedCode } from '@/components/ai-elements/code-block/utils';
import { useMessage } from '@/composables/useMessage';
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
  type ISshPreviewMatchHit,
} from '@/utils/ssh-file-preview';
import { splitTextGraphemes } from '@/utils/text-preview';
import type { ISshFileItem } from '@/types/ssh';
import type { ISshFileReadPayload } from '@/types/tauri';
import type { ThemedToken } from 'shiki';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import ChevronDown from '~icons/lucide/chevron-down';
import ChevronUp from '~icons/lucide/chevron-up';
import Clock3 from '~icons/lucide/clock-3';
import Copy from '~icons/lucide/copy';
import CornerDownLeft from '~icons/lucide/corner-down-left';
import Download from '~icons/lucide/download';
import FileCode2 from '~icons/lucide/file-code-2';
import FileText from '~icons/lucide/file-text';
import HardDrive from '~icons/lucide/hard-drive';
import IndentIncrease from '~icons/lucide/indent-increase';
import Languages from '~icons/lucide/languages';
import ListOrdered from '~icons/lucide/list-ordered';
import MapPin from '~icons/lucide/map-pin';
import PencilLine from '~icons/lucide/pencil-line';
import RefreshCw from '~icons/lucide/refresh-cw';
import Save from '~icons/lucide/save';
import Search from '~icons/lucide/search';
import ShieldCheck from '~icons/lucide/shield-check';
import Terminal from '~icons/lucide/terminal';
import TextWrap from '~icons/lucide/text-wrap';
import UserRound from '~icons/lucide/user-round';
import X from '~icons/lucide/x';

interface IRenderedPreviewSegment {
  key: string;
  text: string;
  style: CSSProperties;
  matched: boolean;
  active: boolean;
}

interface IRenderedPreviewLine {
  key: string;
  lineIndex: number;
  segments: IRenderedPreviewSegment[];
}

interface IIndexedPreviewMatchHit extends ISshPreviewMatchHit {
  globalIndex: number;
}

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
  props.payload ? formatSshPreviewEncoding(props.payload.encoding) : '—',
);
const lineEndingLabel = computed(() =>
  props.payload ? formatSshPreviewLineEnding(props.payload.lineEnding) : '—',
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
      props.payload.encoding,
      props.payload.lineEnding,
    ),
  );
});
const hasUnsavedChanges = computed(() =>
  isEditing.value && currentContent.value !== previewContent.value,
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
  highlightCode(currentContent.value, languageInfo.value.shikiLanguage) ??
  createRawTokens(currentContent.value),
);

watch(
  () => props.fileItem.path,
  () => {
    isSearchOpen.value = false;
    isEditing.value = false;
    searchQuery.value = '';
    activeHitIndex.value = -1;
    cursorPosition.value = { line: 1, column: 1 };
  },
  { immediate: true },
);

watch(
  () => props.payload,
  (payload) => {
    draftContent.value = payload ? normalizeSshPreviewContent(payload.content) : '';
    isEditing.value = false;
    cursorPosition.value = { line: 1, column: 1 };
  },
  { immediate: true },
);

watch(
  () => [currentContent.value, languageInfo.value.shikiLanguage] as const,
  ([code, language]) => {
    tokenized.value = highlightCode(code, language) ?? createRawTokens(code);

    void Promise.resolve().then(() => {
      highlightCode(code, language, (result) => {
        if (
          currentContent.value === code &&
          languageInfo.value.shikiLanguage === language
        ) {
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

const previewFileIcon = computed(() =>
  languageInfo.value.shikiLanguage === 'text' ? FileText : FileCode2,
);

function formatRemoteFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function resolveTokenStyle(token: ThemedToken): CSSProperties {
  return {
    color: token.color ?? undefined,
    backgroundColor: token.bgColor ?? undefined,
    ...token.htmlStyle,
    fontStyle: isItalic(token.fontStyle) ? 'italic' : undefined,
    fontWeight: isBold(token.fontStyle) ? '600' : undefined,
    textDecoration: isUnderline(token.fontStyle) ? 'underline' : undefined,
  };
}

function buildRenderedLineSegments(
  tokens: readonly ThemedToken[],
  line: string,
  lineHits: readonly IIndexedPreviewMatchHit[],
  currentActiveHitIndex: number,
): IRenderedPreviewSegment[] {
  const graphemes = splitTextGraphemes(line);
  if (graphemes.length === 0) {
    return [];
  }

  const styles: CSSProperties[] = [];

  for (const token of tokens) {
    const tokenStyle = resolveTokenStyle(token);
    const tokenGraphemes = splitTextGraphemes(token.content);

    for (let index = 0; index < tokenGraphemes.length; index += 1) {
      styles.push(tokenStyle);
    }
  }

  while (styles.length < graphemes.length) {
    styles.push({});
  }

  if (styles.length > graphemes.length) {
    styles.length = graphemes.length;
  }

  const matchedFlags = Array.from({ length: graphemes.length }, () => ({
    matched: false,
    active: false,
  }));

  for (const hit of lineHits) {
    for (let index = hit.start; index < hit.end && index < matchedFlags.length; index += 1) {
      matchedFlags[index] = {
        matched: true,
        active: hit.globalIndex === currentActiveHitIndex,
      };
    }
  }

  const segments: IRenderedPreviewSegment[] = [];
  let currentText = '';
  let currentStyle = styles[0] ?? {};
  let currentStyleKey = JSON.stringify(currentStyle);
  let currentMatched = matchedFlags[0]?.matched ?? false;
  let currentActive = matchedFlags[0]?.active ?? false;

  const pushSegment = (): void => {
    if (!currentText) {
      return;
    }

    segments.push({
      key: `segment-${segments.length}`,
      text: currentText,
      style: currentStyle,
      matched: currentMatched,
      active: currentActive,
    });
  };

  for (let index = 0; index < graphemes.length; index += 1) {
    const nextStyle = styles[index] ?? {};
    const nextStyleKey = JSON.stringify(nextStyle);
    const nextMatched = matchedFlags[index]?.matched ?? false;
    const nextActive = matchedFlags[index]?.active ?? false;

    if (
      index > 0 &&
      (nextStyleKey !== currentStyleKey ||
        nextMatched !== currentMatched ||
        nextActive !== currentActive)
    ) {
      pushSegment();
      currentText = '';
      currentStyle = nextStyle;
      currentStyleKey = nextStyleKey;
      currentMatched = nextMatched;
      currentActive = nextActive;
    }

    currentText += graphemes[index] ?? '';
  }

  pushSegment();

  return segments;
}

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

  const activeElement = codeViewportRef.value?.querySelector<HTMLElement>(
    '[data-ssh-preview-active-hit="true"]',
  );
  activeElement?.scrollIntoView({
    block: 'center',
    inline: 'nearest',
  });
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
    const targetTop =
      activeHit.lineIndex * lineHeight - editor.clientHeight / 2 + lineHeight;
    editor.scrollTop = Math.max(0, targetTop);
  }
}

function updateCursorFromEditor(target = editorRef.value): void {
  if (!target) {
    return;
  }

  const beforeCursor = target.value.slice(0, target.selectionStart);
  cursorPosition.value = resolveSshPreviewCursorPosition(beforeCursor);
}

function updateCursorFromPreviewSelection(): void {
  const selection = window.getSelection();
  if (!selection || !selection.anchorNode) {
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
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div class="ssh-preview-dialog__scrim" @click.self="requestClose">
      <section class="ssh-preview-dialog" role="dialog" aria-modal="true" aria-label="SSH 文件预览">
        <header class="ssh-preview-dialog__header">
          <div class="ssh-preview-dialog__file-icon" aria-hidden="true">
            <component :is="previewFileIcon" />
          </div>

          <div class="ssh-preview-dialog__title-group">
            <div class="ssh-preview-dialog__filename">{{ fileItem.name }}</div>
            <div class="ssh-preview-dialog__filepath">{{ fileItem.path }}</div>
          </div>

          <div class="ssh-preview-dialog__actions">
            <button
              type="button"
              class="ssh-preview-dialog__icon-button"
              :disabled="!canOpenSearch"
              title="搜索 (Ctrl/Cmd + F)"
              aria-label="搜索"
              @click="focusSearch"
            >
              <Search aria-hidden="true" />
            </button>
            <button
              type="button"
              class="ssh-preview-dialog__icon-button"
              :title="isWrapped ? '关闭自动换行' : '开启自动换行'"
              :aria-label="isWrapped ? '关闭自动换行' : '开启自动换行'"
              @click="isWrapped = !isWrapped"
            >
              <TextWrap aria-hidden="true" />
            </button>
            <button
              type="button"
              class="ssh-preview-dialog__icon-button"
              :disabled="!canReload"
              title="重新加载 (Ctrl/Cmd + R)"
              aria-label="重新加载"
              @click="requestReload"
            >
              <RefreshCw aria-hidden="true" />
            </button>

            <span class="ssh-preview-dialog__divider" aria-hidden="true" />

            <button
              type="button"
              class="ssh-preview-dialog__action-button"
              :disabled="!canCopy"
              @click="requestCopy"
            >
              <Copy aria-hidden="true" />
              <span>复制</span>
            </button>
            <button
              type="button"
              class="ssh-preview-dialog__action-button"
              :disabled="!canDownload"
              @click="requestDownload"
            >
              <Download aria-hidden="true" />
              <span>下载</span>
            </button>
            <button
              v-if="isEditing"
              type="button"
              class="ssh-preview-dialog__action-button"
              :disabled="props.isSaving"
              @click="cancelEditMode"
            >
              <X aria-hidden="true" />
              <span>取消编辑</span>
            </button>
            <button
              v-if="isEditing"
              type="button"
              class="ssh-preview-dialog__action-button ssh-preview-dialog__action-button--primary"
              :disabled="!canSave"
              @click="requestSave"
            >
              <Save aria-hidden="true" />
              <span>{{ props.isSaving ? '保存中…' : '保存' }}</span>
            </button>
            <button
              v-else
              type="button"
              class="ssh-preview-dialog__action-button ssh-preview-dialog__action-button--primary"
              :disabled="!canToggleEdit"
              @click="openEditMode"
            >
              <PencilLine aria-hidden="true" />
              <span>编辑</span>
            </button>

            <span class="ssh-preview-dialog__divider" aria-hidden="true" />

            <button
              type="button"
              class="ssh-preview-dialog__icon-button"
              :disabled="!canClose"
              title="关闭 (Esc)"
              aria-label="关闭"
              @click="requestClose"
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>

        <div class="ssh-preview-dialog__meta">
          <span class="ssh-preview-dialog__meta-item">
            <HardDrive aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">大小</span>
            <b>{{ byteSizeLabel }}</b>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <ListOrdered aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">行数</span>
            <b>{{ lineCountLabel }}</b>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <Languages aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">编码</span>
            <span class="ssh-preview-dialog__badge">{{ encodingLabel }}</span>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <CornerDownLeft aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">换行</span>
            <span class="ssh-preview-dialog__badge">{{ lineEndingLabel }}</span>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <ShieldCheck aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">权限</span>
            <span class="ssh-preview-dialog__mono">{{ payload?.permission ?? '—' }}</span>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <UserRound aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">所有者</span>
            <b>{{ payload?.owner ?? '—' }}</b>
          </span>
          <span class="ssh-preview-dialog__meta-item">
            <Clock3 aria-hidden="true" />
            <span class="ssh-preview-dialog__meta-label">修改</span>
            <b>{{ modifiedAtLabel }}</b>
          </span>

          <span class="ssh-preview-dialog__status" :class="{ 'is-editing': isEditing }">
            {{ statusLabel }}
          </span>
        </div>

        <div
          class="ssh-preview-dialog__toolbar"
          :class="{ 'is-open': isSearchOpen }"
        >
          <div class="ssh-preview-dialog__search">
            <Search aria-hidden="true" />
            <input
              ref="searchInputRef"
              v-model="searchQuery"
              type="text"
              placeholder="在文件中查找…"
              autocomplete="off"
              @keydown="handleSearchInputKeydown"
            >
            <span class="ssh-preview-dialog__search-count">{{ findCountLabel }}</span>
          </div>

          <button
            type="button"
            class="ssh-preview-dialog__icon-button"
            :disabled="indexedHits.length === 0"
            aria-label="上一处"
            @click="stepSearchHit(-1)"
          >
            <ChevronUp aria-hidden="true" />
          </button>
          <button
            type="button"
            class="ssh-preview-dialog__icon-button"
            :disabled="indexedHits.length === 0"
            aria-label="下一处"
            @click="stepSearchHit(1)"
          >
            <ChevronDown aria-hidden="true" />
          </button>
          <button
            type="button"
            class="ssh-preview-dialog__icon-button"
            aria-label="关闭搜索"
            @click="closeSearch"
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div
          ref="codeViewportRef"
          class="ssh-preview-dialog__code"
          :class="{ 'is-wrapped': isWrapped }"
        >
          <div
            v-if="props.isLoading && !props.payload"
            class="ssh-preview-dialog__state"
            aria-live="polite"
          >
            正在读取远端文件…
          </div>

          <template v-else-if="props.payload">
            <div
              v-if="props.isLoading"
              class="ssh-preview-dialog__loading-pill"
              aria-live="polite"
            >
              正在重新加载…
            </div>

            <div v-if="isEditing" class="ssh-preview-dialog__editor-grid">
              <div class="ssh-preview-dialog__gutter" aria-hidden="true">
                <span
                  v-for="lineIndex in currentContentLines.length"
                  :key="`editor-line-${lineIndex}`"
                >
                  {{ lineIndex }}
                </span>
              </div>

              <textarea
                ref="editorRef"
                v-model="draftContent"
                class="ssh-preview-dialog__editor"
                :class="{ 'is-wrapped': isWrapped }"
                :wrap="isWrapped ? 'soft' : 'off'"
                spellcheck="false"
                @click="updateCursorFromEditor()"
                @keyup="updateCursorFromEditor()"
                @select="updateCursorFromEditor()"
                @scroll.passive="updateCursorFromEditor()"
              />
            </div>

            <div v-else class="ssh-preview-dialog__preview-grid" @mouseup="handlePreviewMouseUp">
              <div
                v-for="line in renderedLines"
                :key="line.key"
                class="ssh-preview-dialog__line"
                :data-ssh-preview-line-index="line.lineIndex"
              >
                <div class="ssh-preview-dialog__gutter" aria-hidden="true">
                  <span>{{ line.lineIndex + 1 }}</span>
                </div>

                <div class="ssh-preview-dialog__line-code" data-ssh-preview-line-code="true">
                  <template v-if="line.segments.length === 0">
                    <span class="ssh-preview-dialog__empty-line">&nbsp;</span>
                  </template>

                  <template v-else>
                    <span
                      v-for="segment in line.segments"
                      :key="segment.key"
                      class="ssh-preview-dialog__segment"
                      :class="{
                        'is-match': segment.matched,
                        'is-active-match': segment.active,
                      }"
                      :data-ssh-preview-active-hit="segment.active ? 'true' : undefined"
                      :style="segment.style"
                    >
                      {{ segment.text }}
                    </span>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </div>

        <footer class="ssh-preview-dialog__footer">
          <span class="ssh-preview-dialog__footer-segment">
            <Terminal aria-hidden="true" />
            <span>{{ languageInfo.label }}</span>
          </span>
          <span class="ssh-preview-dialog__footer-segment">
            <MapPin aria-hidden="true" />
            <b>行 {{ cursorPosition.line }}, 列 {{ cursorPosition.column }}</b>
          </span>

          <div class="ssh-preview-dialog__footer-spacer" />

          <button
            type="button"
            class="ssh-preview-dialog__footer-segment ssh-preview-dialog__footer-segment--button"
            @click="isWrapped = !isWrapped"
          >
            <TextWrap aria-hidden="true" />
            <span>换行 {{ isWrapped ? '开' : '关' }}</span>
          </button>
          <span class="ssh-preview-dialog__footer-segment">
            <IndentIncrease aria-hidden="true" />
            <span>Tab=2</span>
          </span>
          <span class="ssh-preview-dialog__footer-segment">{{ encodingLabel }}</span>
          <span class="ssh-preview-dialog__footer-segment">{{ lineEndingLabel }}</span>
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
  background: color-mix(in srgb, var(--background) 70%, transparent);
  backdrop-filter: blur(6px);
}

.ssh-preview-dialog {
  display: flex;
  width: min(920px, calc(100vw - 32px));
  height: min(700px, calc(100vh - 36px));
  min-height: 420px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: calc(var(--radius) + 2px);
  background: color-mix(in srgb, var(--panel-bg) 98%, var(--background));
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--shell-divider) 26%, transparent),
    0 24px 60px color-mix(in srgb, var(--text-primary) 14%, transparent);
}

.ssh-preview-dialog__header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 84%, transparent);
  background: color-mix(in srgb, var(--panel-bg) 98%, transparent);
}

.ssh-preview-dialog__file-icon {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: calc(var(--radius) - 4px);
  background: color-mix(in srgb, var(--accent-strong) 12%, var(--panel-bg));
  color: var(--accent-strong);
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
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ssh-preview-dialog__filepath {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
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
  background: color-mix(in srgb, var(--shell-divider) 86%, transparent);
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
  color: var(--text-secondary);
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
  background: var(--surface-hover);
  color: var(--text-primary);
}

.ssh-preview-dialog__icon-button:active:not(:disabled),
.ssh-preview-dialog__action-button:active:not(:disabled),
.ssh-preview-dialog__footer-segment--button:active:not(:disabled) {
  transform: scale(0.97);
}

.ssh-preview-dialog__icon-button:focus-visible,
.ssh-preview-dialog__action-button:focus-visible,
.ssh-preview-dialog__footer-segment--button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 42%, transparent);
  outline-offset: 2px;
}

.ssh-preview-dialog__action-button--primary {
  background: var(--accent-strong);
  color: var(--accent-foreground);
}

.ssh-preview-dialog__action-button--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-strong) 90%, var(--text-primary));
  color: var(--accent-foreground);
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
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 84%, transparent);
  background: color-mix(in srgb, var(--panel-bg) 98%, transparent);
  color: var(--text-secondary);
  font-size: 12px;
}

.ssh-preview-dialog__meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ssh-preview-dialog__meta-item :deep(svg) {
  color: var(--text-quaternary);
}

.ssh-preview-dialog__meta-label {
  color: var(--text-tertiary);
}

.ssh-preview-dialog__meta-item b,
.ssh-preview-dialog__mono {
  color: var(--text-primary);
  font-size: 11.5px;
  font-weight: 500;
  font-family: var(--font-mono);
}

.ssh-preview-dialog__badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: calc(var(--radius) - 7px);
  background: color-mix(in srgb, var(--surface-hover) 92%, transparent);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10.5px;
}

.ssh-preview-dialog__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  color: color-mix(in srgb, var(--success) 80%, var(--text-primary));
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
  color: color-mix(in srgb, var(--accent-strong) 78%, var(--text-primary));
}

.ssh-preview-dialog__toolbar {
  display: none;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  background: color-mix(in srgb, var(--sidebar-bg) 42%, var(--panel-bg));
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
  border: 1px solid var(--border-subtle);
  border-radius: calc(var(--radius) - 4px);
  background: color-mix(in srgb, var(--panel-bg) 98%, transparent);
  padding: 0 10px;
  transition:
    border-color 160ms cubic-bezier(0.23, 1, 0.32, 1),
    box-shadow 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ssh-preview-dialog__search:focus-within {
  border-color: color-mix(in srgb, var(--accent-strong) 70%, var(--border-strong));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-strong) 16%, transparent);
}

.ssh-preview-dialog__search :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--text-quaternary);
}

.ssh-preview-dialog__search input {
  width: 100%;
  min-width: 0;
  height: 32px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12.5px;
  outline: none;
}

.ssh-preview-dialog__search-count {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.ssh-preview-dialog__code {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  background: color-mix(in srgb, var(--panel-bg) 99%, transparent);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-quaternary) 56%, transparent) transparent;
}

.ssh-preview-dialog__code::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.ssh-preview-dialog__code::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-quaternary) 54%, transparent);
}

.ssh-preview-dialog__code::-webkit-scrollbar-track {
  background: transparent;
}

.ssh-preview-dialog__state {
  display: grid;
  min-height: 100%;
  place-items: center;
  padding: 24px;
  color: var(--text-secondary);
  font-size: 13px;
}

.ssh-preview-dialog__loading-pill {
  position: sticky;
  top: 12px;
  z-index: 2;
  width: fit-content;
  margin: 12px auto 0;
  border: 1px solid color-mix(in srgb, var(--accent-strong) 18%, var(--border-subtle));
  border-radius: calc(var(--radius) - 2px);
  background: color-mix(in srgb, var(--panel-bg) 92%, var(--background));
  padding: 4px 10px;
  color: var(--text-secondary);
  font-size: 11.5px;
  backdrop-filter: blur(4px);
}

.ssh-preview-dialog__preview-grid,
.ssh-preview-dialog__editor-grid {
  min-width: 100%;
}

.ssh-preview-dialog__line,
.ssh-preview-dialog__editor-grid {
  display: grid;
  grid-template-columns: auto 1fr;
}

.ssh-preview-dialog__gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  display: grid;
  align-content: start;
  min-width: 64px;
  padding: 0 12px 0 18px;
  border-right: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  background: color-mix(in srgb, var(--panel-bg) 98%, transparent);
  color: var(--text-tertiary);
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

.ssh-preview-dialog__editor-grid .ssh-preview-dialog__gutter {
  padding-top: 14px;
  padding-bottom: 14px;
}

.ssh-preview-dialog__line-code,
.ssh-preview-dialog__editor {
  min-height: 20px;
  padding: 0 18px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.7;
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
  background: color-mix(in srgb, var(--warning) 42%, transparent);
}

.ssh-preview-dialog__segment.is-active-match {
  background: color-mix(in srgb, var(--warning) 68%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warning) 34%, transparent);
}

.ssh-preview-dialog__empty-line {
  display: inline-block;
  width: 1px;
}

.ssh-preview-dialog__editor {
  width: 100%;
  min-height: calc(100% - 0px);
  border: 0;
  background: transparent;
  color: var(--text-primary);
  resize: none;
  outline: none;
  overflow: auto;
  white-space: pre;
  tab-size: 2;
}

.ssh-preview-dialog__editor.is-wrapped {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.ssh-preview-dialog__editor::selection {
  background: color-mix(in srgb, var(--accent-strong) 24%, transparent);
}

.ssh-preview-dialog__footer {
  display: flex;
  align-items: center;
  gap: 8px 10px;
  padding: 8px 14px;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 84%, transparent);
  background: color-mix(in srgb, var(--sidebar-bg) 44%, var(--panel-bg));
  color: var(--text-secondary);
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
  color: var(--text-primary);
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
