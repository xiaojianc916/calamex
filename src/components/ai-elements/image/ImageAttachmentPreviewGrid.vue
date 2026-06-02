<script setup lang="ts">
import PhotoSwipeLightbox from 'photoswipe/lightbox';
import type { TAttachmentData, TAttachmentVariant } from '@/components/ai-elements/attachments';
import {
  Attachment,
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
  getAttachmentLabel,
  getMediaCategory,
} from '@/components/ai-elements/attachments';
import type { IAiImageAttachmentPreview, TAiAttachmentStatus } from '@/types/ai';
import 'photoswipe/style.css';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type StyleValue } from 'vue';

type TAiImageAttachmentPreviewVariant = 'composer' | 'message';

interface IAiAttachmentPreviewItem {
  id: string;
  name: string;
  preview?: IAiImageAttachmentPreview;
  mediaType?: string;
  detailLabel?: string;
  status?: TAiAttachmentStatus;
  errorMessage?: string;
}

interface IOpenableAttachmentPreviewItem extends IAiAttachmentPreviewItem {
  preview: IAiImageAttachmentPreview & {
    src: string;
    width: number;
    height: number;
  };
}

interface IInternalAttachmentItem {
  item: IAiAttachmentPreviewItem;
  data: TAttachmentData;
  index: number;
  openable: boolean;
}

interface IPhotoSwipeZoomLevelView {
  fit: number;
  elementSize: { x: number; y: number } | null;
}

interface IPhotoSwipeDataSourceItem {
  src: string;
  width: number;
  height: number;
  alt: string;
}

const LIGHTBOX_INITIAL_MAX_WIDTH = 960;
const LIGHTBOX_INITIAL_MAX_HEIGHT = 640;
const LIGHTBOX_VERTICAL_PADDING = 72;
const LIGHTBOX_COMPACT_HORIZONTAL_PADDING = 24;
const LIGHTBOX_DESKTOP_HORIZONTAL_PADDING = 160;
const LIGHTBOX_DESKTOP_MIN_WIDTH = 960;
const LIGHTBOX_SHOW_ANIMATION_DURATION = 0;
const LIGHTBOX_HIDE_ANIMATION_DURATION = 120;
const LIGHTBOX_ZOOM_ANIMATION_DURATION = 160;
const PRELOAD_LIMIT = 4;
const ATTACHMENT_PREVIEW_POINTER_PATTERN = /^idb:\/\/ai-conversation-attachment-preview\//u;

const props = withDefaults(
  defineProps<{
    items: readonly IAiAttachmentPreviewItem[];
    ariaLabel?: string;
    removable?: boolean;
    variant?: TAiImageAttachmentPreviewVariant;
  }>(),
  {
    ariaLabel: '附件预览',
    removable: false,
    variant: 'composer',
  },
);

const emit = defineEmits<{
  remove: [id: string];
}>();

const galleryRef = ref<HTMLElement | null>(null);
let lightbox: PhotoSwipeLightbox | null = null;
let prefersReducedMotion = false;
const imagePreloadHandles = new Map<string, HTMLImageElement>();
const preloadedImageSources = new Set<string>();

const isAttachmentBusy = (item: IAiAttachmentPreviewItem): boolean => item.status === 'processing';
const isAttachmentFailed = (item: IAiAttachmentPreviewItem): boolean => item.status === 'failed';
const isRestoredPreviewSource = (src: string): boolean => !ATTACHMENT_PREVIEW_POINTER_PATTERN.test(src);

const canOpenItem = (item: IAiAttachmentPreviewItem): item is IOpenableAttachmentPreviewItem =>
  !isAttachmentBusy(item) &&
  !isAttachmentFailed(item) &&
  Boolean(item.preview?.src) &&
  isRestoredPreviewSource(item.preview?.src ?? '') &&
  typeof item.preview?.width === 'number' &&
  item.preview.width > 0 &&
  typeof item.preview?.height === 'number' &&
  item.preview.height > 0;

const toAttachmentData = (item: IAiAttachmentPreviewItem): TAttachmentData => ({
  id: item.id,
  type: 'file',
  url: item.preview?.src && isRestoredPreviewSource(item.preview.src) ? item.preview.src : '',
  mediaType: item.preview?.mimeType ?? item.mediaType ?? 'application/octet-stream',
  filename: item.name,
});

const attachmentVariant = computed<TAttachmentVariant>(() =>
  props.variant === 'composer' ? 'inline' : 'grid',
);

const attachmentItems = computed<IInternalAttachmentItem[]>(() =>
  props.items.map((item, index) => ({
    item,
    data: toAttachmentData(item),
    index,
    openable: canOpenItem(item),
  })),
);

const openableItems = computed<IOpenableAttachmentPreviewItem[]>(() =>
  props.items.filter(canOpenItem),
);

const openableIndexes = computed<number[]>(() =>
  attachmentItems.value.reduce<number[]>((indexes, entry) => {
    if (entry.openable) indexes.push(entry.index);
    return indexes;
  }, []),
);

const lightboxDataSource = computed<IPhotoSwipeDataSourceItem[]>(() =>
  openableItems.value.map((item) => ({
    src: item.preview.src,
    width: item.preview.width,
    height: item.preview.height,
    alt: item.name,
  })),
);

const lightboxSignature = computed<string>(() =>
  lightboxDataSource.value.map((d) => `${d.src}|${d.width}x${d.height}`).join('||'),
);

const resolveSecondaryMetaLabel = (entry: IInternalAttachmentItem): string => {
  if (entry.item.status === 'processing') return '处理中…';
  if (entry.item.status === 'failed') return entry.item.errorMessage ?? '处理失败';
  if (entry.item.detailLabel) return entry.item.detailLabel;
  if (entry.openable && entry.item.preview) {
    return `${entry.item.preview.width} × ${entry.item.preview.height}`;
  }
  return '';
};

const resolvePreviewAspectRatio = (
  preview: IAiImageAttachmentPreview | undefined,
): string | undefined => {
  if (
    typeof preview?.width !== 'number' ||
    typeof preview.height !== 'number' ||
    preview.width <= 0 ||
    preview.height <= 0
  ) {
    return undefined;
  }

  return `${preview.width} / ${preview.height}`;
};

const resolveMessageCardStyle = (entry: IInternalAttachmentItem): StyleValue | undefined => {
  if (props.variant !== 'message' || !entry.openable) {
    return undefined;
  }

  const aspectRatio = resolvePreviewAspectRatio(entry.item.preview);

  return aspectRatio
    ? {
        '--ai-attachment-preview-aspect-ratio': aspectRatio,
      }
    : undefined;
};

const destroyLightbox = (): void => {
  lightbox?.destroy();
  lightbox = null;
};

const releasePreloadHandle = (src: string, image: HTMLImageElement): void => {
  if (imagePreloadHandles.get(src) !== image) return;
  image.onload = null;
  image.onerror = null;
  imagePreloadHandles.delete(src);
};

const completeImagePreload = (src: string, image: HTMLImageElement): void => {
  preloadedImageSources.add(src);
  releasePreloadHandle(src, image);
};

const preloadImagePreview = (src: string): void => {
  if (preloadedImageSources.has(src) || imagePreloadHandles.has(src)) return;

  const image = new Image();
  image.decoding = 'async';
  image.onload = () => completeImagePreload(src, image);
  image.onerror = () => releasePreloadHandle(src, image);
  imagePreloadHandles.set(src, image);
  image.src = src;

  if (typeof image.decode === 'function') {
    void image
      .decode()
      .then(() => completeImagePreload(src, image))
      .catch(() => {
        /* decode reject 不视为加载失败 */
      });
  }
};

const clearImagePreloads = (): void => {
  imagePreloadHandles.forEach((image, src) => {
    releasePreloadHandle(src, image);
  });
  preloadedImageSources.clear();
};

const resolveLightboxHorizontalPadding = (viewportWidth: number): number => {
  const vw =
    viewportWidth ||
    (typeof window !== 'undefined' ? window.innerWidth : LIGHTBOX_DESKTOP_MIN_WIDTH);
  if (vw < LIGHTBOX_DESKTOP_MIN_WIDTH) return LIGHTBOX_COMPACT_HORIZONTAL_PADDING;
  return LIGHTBOX_DESKTOP_HORIZONTAL_PADDING;
};

const resolveInitialLightboxZoom = (zoomLevel: IPhotoSwipeZoomLevelView): number => {
  if (!zoomLevel.elementSize) return zoomLevel.fit;
  const widthZoom = LIGHTBOX_INITIAL_MAX_WIDTH / zoomLevel.elementSize.x;
  const heightZoom = LIGHTBOX_INITIAL_MAX_HEIGHT / zoomLevel.elementSize.y;
  return Math.min(zoomLevel.fit, widthZoom, heightZoom);
};

const initLightbox = (): void => {
  if (lightbox || !galleryRef.value) return;
  if (lightboxDataSource.value.length === 0) return;

  const showDuration = prefersReducedMotion ? 0 : LIGHTBOX_SHOW_ANIMATION_DURATION;
  const hideDuration = prefersReducedMotion ? 0 : LIGHTBOX_HIDE_ANIMATION_DURATION;
  const zoomDuration = prefersReducedMotion ? 0 : LIGHTBOX_ZOOM_ANIMATION_DURATION;

  lightbox = new PhotoSwipeLightbox({
    gallery: galleryRef.value,
    children: 'a[data-ai-attachment-preview="image"]',
    pswpModule: () => import('photoswipe'),
    showHideAnimationType: 'none',
    showAnimationDuration: showDuration,
    hideAnimationDuration: hideDuration,
    zoomAnimationDuration: zoomDuration,
    paddingFn: (viewportSize) => {
      const horizontalPadding = resolveLightboxHorizontalPadding(viewportSize.x);
      return {
        top: LIGHTBOX_VERTICAL_PADDING,
        right: horizontalPadding,
        bottom: LIGHTBOX_VERTICAL_PADDING,
        left: horizontalPadding,
      };
    },
    initialZoomLevel: resolveInitialLightboxZoom,
    secondaryZoomLevel: (zoomLevel) => Math.min(zoomLevel.fit, 1),
    maxZoomLevel: (zoomLevel) => Math.max(1, zoomLevel.fit),
    bgOpacity: 0.78,
    mainClass: 'pswp--ai-attachment-preview',
  });
  lightbox.init();
};

const openImagePreview = (item: IAiAttachmentPreviewItem, index: number): void => {
  if (!canOpenItem(item) || !lightbox) return;
  const openableIndex = openableIndexes.value.indexOf(index);
  if (openableIndex < 0) return;
  lightbox.loadAndOpen(openableIndex, lightboxDataSource.value);
};

const handleRemove = (id: string): void => {
  emit('remove', id);
};

onMounted(() => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
});

watch(
  lightboxSignature,
  async (signature) => {
    destroyLightbox();
    if (!signature) return;
    await nextTick();
    initLightbox();
  },
  { immediate: true },
);

watch(
  () => lightboxDataSource.value.slice(0, PRELOAD_LIMIT).map((d) => d.src),
  (sources) => {
    sources.forEach(preloadImagePreview);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  destroyLightbox();
  clearImagePreloads();
});
</script>

<template>
  <div
    v-if="items.length"
    ref="galleryRef"
    class="ai-image-attachment-preview-grid"
    :data-variant="variant"
    :aria-label="ariaLabel"
  >
    <Attachments class="ai-attachment-list" :variant="attachmentVariant">
      <template v-for="entry in attachmentItems" :key="entry.item.id">
        <Attachment
          v-if="attachmentVariant === 'inline'"
          :data="entry.data"
          class="ai-attachment-card"
          :data-status="entry.item.status ?? 'ready'"
          :data-variant="variant"
          @remove="handleRemove(entry.item.id)"
        >
          <AttachmentHoverCard>
            <AttachmentHoverCardTrigger as-child>
              <a
                v-if="entry.openable && entry.item.preview"
                class="ai-image-attachment-preview-link ai-attachment-preview-frame is-openable"
                :href="entry.item.preview.src"
                :data-pswp-src="entry.item.preview.src"
                :data-pswp-width="entry.item.preview.width"
                :data-pswp-height="entry.item.preview.height"
                data-ai-attachment-preview="image"
                role="button"
                aria-haspopup="dialog"
                :aria-label="`查看图片附件 ${entry.item.name}`"
                :title="entry.item.name"
                @click.prevent="openImagePreview(entry.item, entry.index)"
              >
                <AttachmentPreview class="ai-attachment-preview-media" />
              </a>
              <div
                v-else
                class="ai-attachment-preview-frame"
                role="img"
                :aria-label="entry.item.name"
                :title="entry.item.name"
              >
                <AttachmentPreview class="ai-attachment-preview-media" />
              </div>
            </AttachmentHoverCardTrigger>
            <AttachmentHoverCardContent class="ai-attachment-hover-card">
              <div class="ai-attachment-hover-card__content">
                <div
                  v-if="getMediaCategory(entry.data) === 'image' && entry.data.type === 'file' && entry.data.url"
                  class="ai-attachment-hover-card__image"
                >
                  <img :alt="getAttachmentLabel(entry.data)" :src="entry.data.url" loading="lazy" decoding="async">
                </div>
                <div class="ai-attachment-hover-card__meta">
                  <h4 v-text="getAttachmentLabel(entry.data)" />
                  <p v-if="resolveSecondaryMetaLabel(entry)" v-text="resolveSecondaryMetaLabel(entry)" />
                </div>
              </div>
            </AttachmentHoverCardContent>
          </AttachmentHoverCard>

          <span v-if="isAttachmentBusy(entry.item)" class="ai-attachment-processing-overlay" aria-label="附件处理中">
            <span class="icon-[lucide--loader-circle] ai-attachment-processing-spinner" aria-hidden="true" />
          </span>
          <span v-else-if="isAttachmentFailed(entry.item)" class="ai-attachment-failed-overlay" aria-label="附件处理失败">
            <span class="icon-[lucide--triangle-alert] ai-attachment-failed-icon" aria-hidden="true" />
          </span>

          <AttachmentInfo class="ai-attachment-inline-info" />
          <AttachmentRemove v-if="removable" class="ai-image-attachment-preview-remove" label="移除附件" />
        </Attachment>

        <Attachment
          v-else
          :data="entry.data"
          class="ai-attachment-card"
          :class="{ 'is-image-preview': entry.openable }"
          :style="resolveMessageCardStyle(entry)"
          :data-status="entry.item.status ?? 'ready'"
          :data-variant="variant"
          @remove="handleRemove(entry.item.id)"
        >
          <a
            v-if="entry.openable && entry.item.preview"
            class="ai-image-attachment-preview-link ai-attachment-preview-frame is-openable"
            :href="entry.item.preview.src"
            :data-pswp-src="entry.item.preview.src"
            :data-pswp-width="entry.item.preview.width"
            :data-pswp-height="entry.item.preview.height"
            data-ai-attachment-preview="image"
            role="button"
            aria-haspopup="dialog"
            :aria-label="`查看图片附件 ${entry.item.name}`"
            :title="entry.item.name"
            @click.prevent="openImagePreview(entry.item, entry.index)"
          >
            <AttachmentPreview class="ai-attachment-preview-media" />
          </a>
          <div
            v-else
            class="ai-attachment-preview-frame"
            role="img"
            :aria-label="entry.item.name"
            :title="entry.item.name"
          >
            <AttachmentPreview class="ai-attachment-preview-media" />
          </div>
          <span v-if="isAttachmentBusy(entry.item)" class="ai-attachment-processing-overlay" aria-label="附件处理中">
            <span class="icon-[lucide--loader-circle] ai-attachment-processing-spinner" aria-hidden="true" />
          </span>
          <span v-else-if="isAttachmentFailed(entry.item)" class="ai-attachment-failed-overlay" aria-label="附件处理失败">
            <span class="icon-[lucide--triangle-alert] ai-attachment-failed-icon" aria-hidden="true" />
          </span>
          <span class="sr-only" v-text="entry.item.name" />
          <AttachmentRemove v-if="removable" class="ai-image-attachment-preview-remove" label="移除附件" />
        </Attachment>
      </template>
    </Attachments>
  </div>
</template>

<style scoped>
.ai-image-attachment-preview-grid {
  min-width: 0;
}

.ai-image-attachment-preview-grid[data-variant='message'] {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.ai-attachment-list {
  max-width: 100%;
}

.ai-image-attachment-preview-grid[data-variant='composer'] .ai-attachment-list {
  justify-content: flex-start;
}

.ai-image-attachment-preview-grid[data-variant='message'] .ai-attachment-list {
  justify-content: flex-end;
}

.ai-attachment-card {
  position: relative;
  border-color: color-mix(in srgb, var(--shell-divider) 82%, transparent);
  background: var(--surface-default, #ffffff);
  color: var(--text-primary);
}

.ai-attachment-card[data-variant='composer'] {
  max-width: min(100%, 220px);
  border-radius: 8px;
  background: var(--surface-default, #ffffff);
  padding: 0 6px 0 4px;
  color: var(--text-primary);
}

.ai-attachment-card[data-variant='message'] {
  width: 96px;
  height: 96px;
  border-radius: 12px;
  background: var(--surface-subtle, #f4f4f5);
}

.ai-attachment-card[data-variant='message'].is-image-preview {
  width: min(320px, 72vw);
  max-width: 100%;
  height: auto;
  max-height: 220px;
  aspect-ratio: var(--ai-attachment-preview-aspect-ratio, 4 / 3);
  border-color: color-mix(in srgb, var(--shell-divider) 86%, transparent);
  background: var(--surface-default, #ffffff);
}

.ai-attachment-preview-frame {
  display: flex;
  position: relative;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--text-tertiary);
  text-decoration: none;
}

.ai-attachment-card[data-variant='composer'] .ai-attachment-preview-frame {
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: transparent;
}

.ai-attachment-card[data-variant='message'] .ai-attachment-preview-frame {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: var(--surface-subtle, #f4f4f5);
}

.ai-attachment-card[data-variant='message'].is-image-preview .ai-attachment-preview-frame {
  background: var(--surface-default, #ffffff);
}

.ai-attachment-preview-frame :deep(.ai-attachment-preview-media) {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: transparent;
}

.ai-image-attachment-preview-link.is-openable {
  cursor: pointer;
}

.ai-image-attachment-preview-link:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 22%, transparent);
  outline-offset: 2px;
}

.ai-attachment-preview-frame :deep(img),
.ai-attachment-preview-frame :deep(video) {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  background: transparent;
  object-fit: cover;
}

.ai-attachment-card[data-variant='composer'] .ai-attachment-preview-frame :deep(img),
.ai-attachment-card[data-variant='composer'] .ai-attachment-preview-frame :deep(video) {
  object-fit: cover;
}

.ai-attachment-card[data-variant='message'].is-image-preview .ai-attachment-preview-frame :deep(img),
.ai-attachment-card[data-variant='message'].is-image-preview .ai-attachment-preview-frame :deep(video) {
  object-fit: contain;
}

.ai-attachment-inline-info {
  min-width: 0;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 20px;
}

.ai-attachment-processing-overlay,
.ai-attachment-failed-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: grid;
  place-items: center;
  border-radius: inherit;
  background: color-mix(in srgb, var(--surface-default, #ffffff) 72%, transparent);
  backdrop-filter: blur(1px);
  pointer-events: none;
}

.ai-attachment-card[data-variant='composer'] .ai-attachment-processing-overlay,
.ai-attachment-card[data-variant='composer'] .ai-attachment-failed-overlay {
  inset: 0 auto 0 0;
  width: 28px;
  height: 28px;
  margin: auto 0;
  border-radius: 4px;
}

.ai-attachment-processing-spinner,
.ai-attachment-failed-icon {
  width: 16px;
  height: 16px;
  color: var(--text-secondary);
}

.ai-attachment-processing-spinner {
  animation: ai-attachment-spin 820ms linear infinite;
}

.ai-attachment-failed-icon {
  color: var(--danger);
}

@keyframes ai-attachment-spin {
  to {
    transform: rotate(360deg);
  }
}

.ai-image-attachment-preview-remove {
  color: var(--text-tertiary);
}

.ai-attachment-card[data-variant='composer'] .ai-image-attachment-preview-remove {
  position: static;
  flex: 0 0 auto;
  max-width: 0;
  margin-left: 0;
  overflow: hidden;
  opacity: 0;
  transform: translateX(6px);
  pointer-events: none;
  transition:
    max-width 220ms cubic-bezier(0.2, 0, 0, 1),
    margin-left 220ms cubic-bezier(0.2, 0, 0, 1),
    opacity 160ms ease,
    transform 220ms cubic-bezier(0.2, 0, 0, 1);
}

.ai-attachment-card[data-variant='composer']:hover .ai-image-attachment-preview-remove,
.ai-attachment-card[data-variant='composer']:focus-within .ai-image-attachment-preview-remove {
  max-width: 28px;
  margin-left: 4px;
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}

.ai-attachment-card[data-variant='message'] .ai-image-attachment-preview-remove {
  background: color-mix(in srgb, var(--surface-default, #ffffff) 88%, transparent);
  color: var(--text-secondary);
  opacity: 0;
  transform: translateX(6px);
  pointer-events: none;
  transition:
    opacity 160ms ease,
    transform 220ms cubic-bezier(0.2, 0, 0, 1);
}

.ai-attachment-card[data-variant='message']:hover .ai-image-attachment-preview-remove,
.ai-attachment-card[data-variant='message']:focus-within .ai-image-attachment-preview-remove {
  opacity: 1;
  transform: translateX(0);
  pointer-events: auto;
}

:global(.ai-attachment-hover-card) {
  border: 1px solid rgba(15, 17, 21, 0.10);
  border-radius: 8px;
  background: #ffffff;
  color: #1f2328;
  box-shadow:
    0 24px 48px -16px rgba(15, 17, 21, 0.18),
    0 8px 16px -8px rgba(15, 17, 21, 0.10),
    0 1px 2px rgba(15, 17, 21, 0.06);
}

:global(.ai-attachment-hover-card .ai-attachment-hover-card__content) {
  display: grid;
  gap: 4px;
  min-width: 0;
}

:global(.ai-attachment-hover-card .ai-attachment-hover-card__image) {
  display: flex;
  width: 320px;
  max-width: 72vw;
  max-height: 384px;
  align-items: center;
  justify-content: center;
  overflow: visible;
  border: 0;
  border-radius: 8px;
  background: #ffffff;
}

:global(.ai-attachment-hover-card .ai-attachment-hover-card__image img) {
  display: block;
  max-width: 100%;
  max-height: 384px;
  border-radius: 8px;
  object-fit: contain;
  box-shadow:
    0 1px 2px rgba(15, 17, 21, 0.05),
    0 6px 16px -8px rgba(15, 17, 21, 0.10);
}

:global(.ai-attachment-hover-card .ai-attachment-hover-card__meta) {
  min-width: 0;
  padding: 0 2px;
}

:global(.ai-attachment-hover-card .ai-attachment-hover-card__meta h4) {
  margin: 0;
  color: #1f2328;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}

:global(.ai-attachment-hover-card .ai-attachment-hover-card__meta p) {
  margin: 2px 0 0;
  color: #59636e;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 16px;
}

:global(.pswp--ai-attachment-preview .pswp__img),
:global(.pswp--ai-attachment-preview .pswp__img--placeholder) {
  border-radius: var(--image-attachment-preview-radius, 12px);
  background: var(--image-preview-frame-surface);
  box-shadow: var(--image-attachment-preview-shadow, var(--image-preview-frame-shadow));
}

:global(.pswp--ai-attachment-preview .pswp__img--placeholder) {
  object-fit: cover;
}

:global(.pswp--ai-attachment-preview) {
  --pswp-transition-duration: 180ms;
}

@media (prefers-reduced-motion: reduce) {
  .ai-attachment-card,
  .ai-image-attachment-preview-remove,
  .ai-attachment-processing-spinner {
    transition: none !important;
    animation: none !important;
  }

  :global(.pswp--ai-attachment-preview) {
    --pswp-transition-duration: 0ms;
  }
}
</style>
