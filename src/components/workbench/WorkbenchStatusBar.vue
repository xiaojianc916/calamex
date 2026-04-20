<template>
  <footer
    class="workbench-statusbar flex h-7 items-center justify-between border-t border-(--shell-divider) px-1 text-[11px]">
    <div class="flex h-full items-center gap-0.5">
      <span class="statusbar-segment statusbar-segment-passive">
        <span class="h-2 w-2 rounded-full" :class="isRunning ? 'bg-amber-400' : 'bg-emerald-400'" />
        {{ isRunning ? '运行中' : '就绪' }}
      </span>

      <span v-if="statusMessage" class="statusbar-segment statusbar-segment-passive statusbar-segment-flash">
        {{ statusMessage }}
      </span>

      <span v-if="!hasActiveDocument" class="statusbar-segment statusbar-segment-passive">
        未打开文件
      </span>
      <span v-else-if="documentKind === 'image'" class="statusbar-segment statusbar-segment-passive">
        图片预览
      </span>
    </div>

    <div class="flex h-full items-center gap-0.5">
      <template v-if="hasActiveDocument && documentKind === 'text'">
        <span
class="statusbar-segment statusbar-segment-button app-tooltip-target"
          :data-tooltip="cursorPositionTooltip" data-tooltip-placement="top">
          {{ cursorLine }}:{{ cursorColumn }}
        </span>
        <span
class="statusbar-segment statusbar-segment-button app-tooltip-target" :data-tooltip="charCountTooltip"
          data-tooltip-placement="top">
          {{ charCount }} char
        </span>
        <span
class="statusbar-segment statusbar-segment-button app-tooltip-target" data-tooltip="LF 行尾序列"
          data-tooltip-placement="top">
          LF
        </span>

        <AppDropdownMenu :items="encodingItems" align="right" :min-width="118" @select="handleEncodingChange">
          <template #trigger="{ open }">
            <button
type="button" class="statusbar-segment statusbar-segment-button app-tooltip-target"
              :class="{ 'is-open': open }" :data-tooltip="encodingTooltip" data-tooltip-placement="top">
              {{ encodingLabel }}
            </button>
          </template>
        </AppDropdownMenu>

        <span
class="statusbar-segment app-tooltip-target" :class="{ 'statusbar-segment-passive': !isTerminalReady }"
          :data-tooltip="executorTooltip" data-tooltip-placement="top">
          {{ executorLabel }}
        </span>
      </template>

      <template v-else-if="hasActiveDocument && documentKind === 'image'">
        <span class="statusbar-segment statusbar-segment-passive">只读</span>
      </template>
    </div>
  </footer>
</template>

<script setup lang="ts">
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import { useIntegratedTerminalStatus } from '@/composables/useIntegratedTerminal';
import type { TDocumentEncoding, TExecutorKind } from '@/types/editor';
import { ENCODING_OPTIONS, getExecutorLabel } from '@/utils/templates';
import { computed } from 'vue';

const props = defineProps<{
  hasActiveDocument: boolean;
  documentKind: 'text' | 'image';
  isRunning: boolean;
  statusMessage?: string | null;
  encoding: TDocumentEncoding;
  executor: TExecutorKind;
  cursorLine: number;
  cursorColumn: number;
  charCount: number;
}>();

const emit = defineEmits<{
  'change-encoding': [value: TDocumentEncoding];
}>();

const { status: terminalStatus, statusMessage: terminalStatusMessage } =
  useIntegratedTerminalStatus();

const encodingLabel = computed(
  () =>
    ENCODING_OPTIONS.find((item) => item.value === props.encoding)?.label ??
    props.encoding.toUpperCase(),
);

const executorLabel = computed(() => getExecutorLabel(props.executor));
const isTerminalReady = computed(() => terminalStatus.value === 'ready');
const cursorPositionTooltip = computed(
  () => `第 ${props.cursorLine} 行，第 ${props.cursorColumn} 列`,
);
const charCountTooltip = computed(() => `${props.charCount} 个字符`);
const encodingTooltip = computed(() => `${encodingLabel.value} 编码`);
const executorTooltip = computed(() =>
  isTerminalReady.value
    ? '执行环境固定为 WSL2，终端已连接'
    : terminalStatusMessage.value || '执行环境固定为 WSL2',
);

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
