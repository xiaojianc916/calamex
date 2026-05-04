<template>
  <footer
    class="workbench-statusbar flex h-7 w-full min-w-0 shrink-0 items-center justify-between border-t border-(--shell-divider) px-1 text-[11px]">
    <div class="flex h-full items-center gap-0.5">
      <!-- Git branch + changes -->
      <button
v-if="gitBranchName" type="button" class="statusbar-segment statusbar-segment-button statusbar-git-branch"
        :title="`分支 ${gitBranchName}，点击打开源代码管理`" @click="$emit('open-source-control')">
        <svg
class="inline-block" style="width:10px;height:10px;margin-right:4px;vertical-align:-1px"
          viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
          stroke-linejoin="round" aria-hidden="true">
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="8" r="1.5" />
          <path d="M4 4.5v7" />
          <path d="M12 9.5v-1a4 4 0 0 0-4-4H6" />
        </svg>
        <span>{{ gitBranchName }}</span>
        <span v-if="(gitAddedCount ?? 0) > 0" class="statusbar-git-added"> +{{ gitAddedCount }}</span>
        <span v-if="(gitRemovedCount ?? 0) > 0" class="statusbar-git-removed"> −{{ gitRemovedCount }}</span>
      </button>

      <span v-if="statusMessage" class="statusbar-segment statusbar-segment-passive statusbar-segment-flash">
        {{ statusMessage }}
      </span>

      <span v-if="hasActiveDocument && documentKind === 'image'" class="statusbar-segment statusbar-segment-passive">
        图片预览
      </span>

      <span v-if="hasActiveDocument && documentKind === 'git-diff'" class="statusbar-segment statusbar-segment-passive">
        Git Diff
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

        <button
type="button"
          class="statusbar-segment statusbar-segment-button statusbar-diagnostics app-tooltip-target"
          :data-tooltip="diagnosticStatusTooltip" data-tooltip-placement="top" :aria-label="diagnosticStatusAriaLabel"
          @click="$emit('open-diagnostics')">
          <span v-if="!scriptAnalysis.available" class="statusbar-diagnostics-item is-warning">
            <svg
viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path d="M8 2.5 14 13H2L8 2.5Z" />
              <path d="M8 6.2v3.1M8 11.6h.01" />
            </svg>
            <span>unavailable</span>
          </span>

          <span v-else-if="diagnosticStatusSummary.issueCount === 0" class="statusbar-diagnostics-item is-ok">
            <svg
viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <circle cx="8" cy="8" r="5.5" />
              <path d="m5 8.2 2 2 4.2-4.4" />
            </svg>
            <span>0 issues</span>
          </span>

          <template v-else>
            <span v-if="diagnosticStatusSummary.errorCount > 0" class="statusbar-diagnostics-item is-error">
              <svg
viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" />
                <path d="m5.8 5.8 4.4 4.4M10.2 5.8 5.8 10.2" />
              </svg>
              <span>{{ diagnosticStatusSummary.errorCount }}</span>
            </span>

            <span v-if="diagnosticStatusSummary.warningCount > 0" class="statusbar-diagnostics-item is-warning">
              <svg
viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
                <path d="M8 2.5 14 13H2L8 2.5Z" />
                <path d="M8 6.2v3.1M8 11.6h.01" />
              </svg>
              <span>{{ diagnosticStatusSummary.warningCount }}</span>
            </span>

            <span v-if="diagnosticStatusSummary.infoCount > 0" class="statusbar-diagnostics-item is-info">
              <svg
viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
                stroke-linejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="5.5" />
                <path d="M8 7.2v3.6M8 5.1h.01" />
              </svg>
              <span>{{ diagnosticStatusSummary.infoCount }}</span>
            </span>
          </template>
        </button>
      </template>

      <template v-else-if="hasActiveDocument && documentKind === 'image'">
        <span class="statusbar-segment statusbar-segment-passive">只读</span>
      </template>

      <template v-else-if="hasActiveDocument && documentKind === 'git-diff'">
        <span class="statusbar-segment statusbar-segment-passive">Split Diff</span>
        <span class="statusbar-segment statusbar-segment-passive">只读</span>
      </template>
    </div>
  </footer>
</template>

<script setup lang="ts">
import AppDropdownMenu from '@/components/common/AppDropdownMenu.vue';
import { useIntegratedTerminalStatus } from '@/composables/useIntegratedTerminal';
import type {
  IAnalyzeScriptPayload,
  TDocumentEncoding,
  TDocumentKind,
  TExecutorKind,
} from '@/types/editor';
import { resolveShellcheckStatusSummary } from '@/utils/shellcheck-status';
import { ENCODING_OPTIONS, getExecutorLabel } from '@/utils/templates';
import { computed } from 'vue';

const props = defineProps<{
  hasActiveDocument: boolean;
  documentKind: TDocumentKind;
  statusMessage?: string | null;
  scriptAnalysis: IAnalyzeScriptPayload;
  encoding: TDocumentEncoding;
  executor: TExecutorKind;
  cursorLine: number;
  cursorColumn: number;
  charCount: number;
  gitBranchName?: string | null;
  gitAddedCount?: number;
  gitRemovedCount?: number;
}>();

const emit = defineEmits<{
  'change-encoding': [value: TDocumentEncoding];
  'open-source-control': [];
  'open-diagnostics': [];
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
    ? '终端已连接'
    : terminalStatusMessage.value || '执行环境固定为 WSL2',
);
const diagnosticStatusSummary = computed(() =>
  resolveShellcheckStatusSummary(props.scriptAnalysis),
);
const diagnosticStatusLabel = computed(() => diagnosticStatusSummary.value.label);
const diagnosticStatusTooltip = computed(() => {
  if (!props.scriptAnalysis.available) {
    return props.scriptAnalysis.message
      ? `ShellCheck 当前不可用：${props.scriptAnalysis.message}`
      : 'ShellCheck 当前不可用';
  }

  return diagnosticStatusSummary.value.issueCount === 0
    ? '没有发现问题'
    : `ShellCheck 当前文件：${diagnosticStatusLabel.value}`;
});
const diagnosticStatusAriaLabel = computed(() =>
  `打开 ShellCheck 代码检查面板，${diagnosticStatusLabel.value}`,
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
