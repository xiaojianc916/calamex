<script setup lang="ts">
import { computed, type HTMLAttributes, type VNode } from 'vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { cn } from '@/lib/utils';
import { useAttachmentContext } from './context';
import type { TAttachmentMediaCategory } from './types';

interface IProps {
  fallbackIcon?: VNode;
  class?: HTMLAttributes['class'];
}

const props = defineProps<IProps>();

const { data, mediaCategory, variant } = useAttachmentContext();

const isGrid = computed(() => variant.value === 'grid');
const iconSize = computed(() => (variant.value === 'inline' ? 'size-3' : 'size-4'));
const fileUrl = computed(() => (data.value.type === 'file' ? data.value.url : undefined));
const showImage = computed(
  () => mediaCategory.value === 'image' && data.value.type === 'file' && Boolean(fileUrl.value),
);
const showVideo = computed(
  () => mediaCategory.value === 'video' && data.value.type === 'file' && Boolean(fileUrl.value),
);

const iconMap: Record<TAttachmentMediaCategory, string> = {
  image: 'image',
  video: 'video',
  audio: 'music-2',
  source: 'globe',
  document: 'file-text',
  unknown: 'paperclip',
};

const iconComponent = computed(() => iconMap[mediaCategory.value]);
const imageAlt = computed(
  () => (data.value.type === 'file' ? data.value.filename : undefined) || 'Image',
);
</script>

<template>
  <div :class="cn(
    'flex shrink-0 items-center justify-center overflow-hidden',
    variant === 'grid' && 'size-full bg-muted',
    variant === 'inline' && 'size-5 rounded bg-background',
    variant === 'list' && 'size-12 rounded bg-muted',
    props.class,
  )" v-bind="$attrs">
    <img v-if="showImage" :alt="imageAlt" :class="isGrid ? 'size-full object-cover' : 'size-full rounded object-cover'"
      :height="isGrid ? 96 : 20" :src="fileUrl" :width="isGrid ? 96 : 20" loading="lazy" decoding="async"
      draggable="false">
    <video v-else-if="showVideo" class="size-full object-cover" muted :src="fileUrl" />
    <component :is="props.fallbackIcon" v-else-if="props.fallbackIcon" />
    <LucideIcon v-else :name="iconComponent" :class="cn(iconSize, 'text-muted-foreground')" />
  </div>
</template>
