<template>
  <footer class="workbench-statusbar flex h-7 items-center justify-between border-t border-[var(--shell-divider)] px-1 text-[11px]">
    <div class="flex h-full items-center gap-0.5">
      <template v-if="documentKind === 'text'">
        <span
          v-if="!diagnosticAvailable && diagnosticMessage"
          class="statusbar-segment statusbar-segment-passive app-tooltip-target statusbar-segment-diagnostic is-warning"
          :data-tooltip="diagnosticMessage"
          data-tooltip-placement="top"
        >
          ShellCheck 未就绪
        </span>

        <span
          v-if="diagnosticErrors > 0"
          class="statusbar-segment app-tooltip-target statusbar-segment-diagnostic is-error"
          :data-tooltip="diagnosticErrorsTooltip"
          data-tooltip-placement="top"
        >
          {{ diagnosticErrors }} 错误
        </span>

        <span
          v-if="diagnosticWarnings > 0"
          class="statusbar-segment app-tooltip-target statusbar-segment-diagnostic is-warning"
          :data-tooltip="diagnosticWarningsTooltip"
          data-tooltip-placement="top"
        >
          {{ diagnosticWarnings }} 警告
        </span>

        <span
          v-if="diagnosticInfos > 0"
          class="statusbar-segment app-tooltip-target statusbar-segment-diagnostic is-info"
          :data-tooltip="diagnosticInfosTooltip"
          data-tooltip-placement="top"
        >
          {{ diagnosticInfos }} 提示
        </span>
      </template>

      <span class="statusbar-segment statusbar-segment-passive">
        <span class="h-2 w-2 rounded-full" :class="isRunning ? 'bg-amber-400' : 'bg-emerald-400'" />
        {{ isRunning ? '运行中' : '就绪' }}
      </span>
    </div>

    <div class="flex h-full items-center gap-0.5">
      <template v-if="documentKind === 'text'">
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

        <AppDropdownMenu
          :items="encodingItems"
          align="right"
          :min-width="118"
          @select="handleEncodingChange"
        >
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

        <span
          class="statusbar-segment statusbar-segment-passive app-tooltip-target"
          data-tooltip="执行环境固定为 WSL2"
          data-tooltip-placement="top"
        >
          {{ executorLabel }}
        </span>
      </template>

      <template v-else>
        <span class="statusbar-segment statusbar-segment-passive">图片预览</span>
        <span class="statusbar-segment statusbar-segment-passive">只读</span>
      </template>
    </div>
  </footer>
</template>

<script setup lang="ts">
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import type { TDocumentEncoding, TExecutorKind } from '@/types/editor';
import { ENCODING_OPTIONS, getExecutorLabel } from '@/utils/templates';
import { computed } from 'vue';

const props = defineProps<{
  documentKind: 'text' | 'image';
  isRunning: boolean;
  encoding: TDocumentEncoding;
  executor: TExecutorKind;
  cursorLine: number;
  cursorColumn: number;
  charCount: number;
  diagnosticAvailable: boolean;
  diagnosticMessage: string | null;
  diagnosticErrors: number;
  diagnosticWarnings: number;
  diagnosticInfos: number;
}>();

const emit = defineEmits<{
  'change-encoding': [value: TDocumentEncoding];
}>();

const encodingLabel = computed(() =>
  ENCODING_OPTIONS.find((item) => item.value === props.encoding)?.label ?? props.encoding.toUpperCase(),
);

const executorLabel = computed(() => getExecutorLabel(props.executor));

const cursorPositionTooltip = computed(() => `${props.cursorLine} 行 : ${props.cursorColumn} 列`);

const charCountTooltip = computed(() => `${props.charCount} 字符`);

const encodingTooltip = computed(() => `${encodingLabel.value}编码`);
const diagnosticErrorsTooltip = computed(() => `ShellCheck 已发现 ${props.diagnosticErrors} 个错误`);
const diagnosticWarningsTooltip = computed(() => `ShellCheck 已发现 ${props.diagnosticWarnings} 个警告`);
const diagnosticInfosTooltip = computed(() => `ShellCheck 已发现 ${props.diagnosticInfos} 条提示`);

const encodingItems = computed(() =>
  ENCODING_OPTIONS.map((item) => ({
    key: item.value,
    label: item.label,
    selected: item.value === props.encoding,
  })),
);

const handleEncodingChange = (key: string): void => {
  emit('change-encoding', key as TDocumentEncoding);
};
</script>
