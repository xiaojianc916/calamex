<template>
  <div class="flex h-full min-h-0 flex-col bg-(--editor-bg)">
    <div class="flex items-center justify-between border-b border-(--shell-divider) px-5 py-3">
      <div class="min-w-0">
        <p class="text-[11px] font-medium uppercase tracking-[0.14em] text-(--text-quaternary)">
          图片预览
        </p>
        <p
          class="mt-1 truncate text-[13px] font-medium text-(--text-primary)"
          v-text="props.name"
        ></p>
      </div>
      <div class="flex items-center gap-2 text-[11px] text-(--text-quaternary)">
        <span v-if="assetMeta" v-text="assetMeta.mimeType"></span>
        <span v-if="assetMeta" v-text="formatBytes(assetMeta.byteSize)"></span>
        <span v-if="imageSizeLabel" v-text="imageSizeLabel"></span>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-5">
      <div
        v-if="isLoading"
        class="flex h-full min-h-60 items-center justify-center rounded-xl border border-white/6 bg-white/2 text-[12px] text-(--text-quaternary)"
      >
        正在加载图片资源…
      </div>

      <div v-else-if="errorMessage" class="flex h-full min-h-60 items-center justify-center px-6">
        <InlineError class="max-w-md" title="图片预览失败" :message="errorMessage" />
      </div>

      <div
        v-else
        class="flex min-h-full items-center justify-center rounded-[20px] border border-white/6 bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.015))] p-6"
      >
        <div class="image-preview-frame">
          <img
            v-if="assetMeta"
            :src="imageSrc"
            :alt="props.name"
            class="image-preview-asset"
            @load="handleImageLoad"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { convertFileSrc } from '@tauri-apps/api/core';
import { computed, onMounted, ref, watch } from 'vue';
import InlineError from '@/components/common/InlineError.vue';
import { tauriService } from '@/services/tauri';
import type { IImageAssetPayload } from '@/types/editor';
import { toErrorMessage } from '@/utils/error';
import { formatBytes } from '@/utils/file-assets';

const props = defineProps<{
  path: string;
  name: string;
}>();

const assetMeta = ref<IImageAssetPayload | null>(null);
const isLoading = ref(false);
const errorMessage = ref('');
const imageNaturalWidth = ref(0);
const imageNaturalHeight = ref(0);

// 通过 asset 协议把规范化后的真实路径转成 webview 可直接加载的 URL，
// 由原生层按需流式读取图片，避免 base64 over IPC。
const imageSrc = computed(() =>
  assetMeta.value ? convertFileSrc(assetMeta.value.path) : '',
);

const imageSizeLabel = computed(() => {
  if (imageNaturalWidth.value <= 0 || imageNaturalHeight.value <= 0) {
    return '';
  }

  return `${imageNaturalWidth.value} × ${imageNaturalHeight.value}`;
});

// 自增请求序号：path 快速切换时多个加载会并发，只有最后一次请求的结果允许落地，
// 丢弃乱序返回的过期响应，避免在新路径下显示旧图片。
let loadToken = 0;

const loadImageAsset = async (): Promise<void> => {
  const token = ++loadToken;
  isLoading.value = true;
  errorMessage.value = '';
  assetMeta.value = null;
  imageNaturalWidth.value = 0;
  imageNaturalHeight.value = 0;

  try {
    const payload = await tauriService.loadImageAsset(props.path);
    if (token !== loadToken) {
      return;
    }
    assetMeta.value = payload;
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    errorMessage.value = toErrorMessage(error, '读取图片资源失败。');
  } finally {
    if (token === loadToken) {
      isLoading.value = false;
    }
  }
};

const handleImageLoad = (event: Event): void => {
  const target = event.target;
  if (!(target instanceof HTMLImageElement)) {
    return;
  }

  imageNaturalWidth.value = target.naturalWidth;
  imageNaturalHeight.value = target.naturalHeight;
};

watch(
  () => props.path,
  () => {
    void loadImageAsset();
  },
);

onMounted(() => {
  void loadImageAsset();
});
</script>
