<template>
  <footer class="workbench-statusbar flex h-7 items-center justify-between border-t border-[var(--shell-divider)] px-1 text-[11px]">
    <div class="flex h-full items-center gap-0.5">
      <span class="statusbar-segment statusbar-segment-passive">
        <span class="h-2 w-2 rounded-full" :class="isRunning ? 'bg-amber-400' : 'bg-emerald-400'" />
        {{ isRunning ? '运行中' : '就绪' }}
      </span>
    </div>

    <div class="flex h-full items-center gap-0.5">
      <span
        class="statusbar-segment statusbar-segment-button app-tooltip-target"
        :data-tooltip="cursorPositionTooltip"
        data-tooltip-placement="top"
      >
        {{ cursorLine }}:{{ cursorColumn }}
      </span>
      <span
        class="statusbar-segment statusbar-segment-button app-tooltip-target"
        :data-tooltip="charCountTooltip"
        data-tooltip-placement="top"
      >
        {{ charCount }} char
      </span>
      <span
        class="statusbar-segment statusbar-segment-button app-tooltip-target"
        data-tooltip="LF 行尾序列"
        data-tooltip-placement="top"
      >
        LF
      </span>

      <AppDropdownMenu :items="encodingItems" align="right" :min-width="118" @select="handleEncodingChange">
        <template #trigger="{ open, toggle }">
          <button
            type="button"
            class="statusbar-segment statusbar-segment-button app-tooltip-target"
            :class="{ 'is-open': open }"
            :data-tooltip="encodingTooltip"
            data-tooltip-placement="top"
            @click="toggle"
          >
            {{ encodingLabel }}
          </button>
        </template>
      </AppDropdownMenu>

      <AppDropdownMenu :items="executorItems" align="right" :min-width="138" @select="handleExecutorChange">
        <template #trigger="{ open, toggle }">
          <button
            type="button"
            class="statusbar-segment statusbar-segment-button app-tooltip-target"
            :class="{ 'is-open': open }"
            data-tooltip="执行方案"
            data-tooltip-placement="top"
            @click="toggle"
          >
            {{ executorLabel }}
          </button>
        </template>
      </AppDropdownMenu>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import { ENCODING_OPTIONS, EXECUTOR_OPTIONS, getExecutorLabel } from '@/utils/templates';
import type { TDocumentEncoding, TExecutorKind } from '@/types/editor';

const props = defineProps<{
  isRunning: boolean;
  encoding: TDocumentEncoding;
  executor: TExecutorKind;
  cursorLine: number;
  cursorColumn: number;
  charCount: number;
}>();

const emit = defineEmits<{
  'change-encoding': [value: TDocumentEncoding];
  'change-executor': [value: TExecutorKind];
}>();

const encodingLabel = computed(() =>
  ENCODING_OPTIONS.find((item) => item.value === props.encoding)?.label ?? props.encoding.toUpperCase(),
);

const executorLabel = computed(() => getExecutorLabel(props.executor));

const cursorPositionTooltip = computed(() => `${props.cursorLine} 行 : ${props.cursorColumn} 列`);

const charCountTooltip = computed(() => `${props.charCount} 字符`);

const encodingTooltip = computed(() => `${encodingLabel.value}编码`);

const encodingItems = computed(() =>
  ENCODING_OPTIONS.map((item) => ({
    key: item.value,
    label: item.label,
    selected: item.value === props.encoding,
  })),
);

const executorItems = computed(() =>
  EXECUTOR_OPTIONS.map((item) => ({
    key: item.value,
    label: item.label,
    selected: item.value === props.executor,
  })),
);

const handleEncodingChange = (key: string): void => {
  emit('change-encoding', key as TDocumentEncoding);
};

const handleExecutorChange = (key: string): void => {
  emit('change-executor', key as TExecutorKind);
};
</script>
