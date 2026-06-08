<script setup lang="ts">
import { computed } from 'vue';

import { RunStatusBar } from '@/components/ai-elements/run-status';
import type {
  IAiAgentRun,
  IAiToolConfirmationRequest,
  TAiToolConfirmationDecision,
} from '@/types/ai';

import { deriveRunStatus } from './projection';
import { useElapsedSeconds } from './useElapsedSeconds';

/**
 * 业务包装件:把活动 run + 可见工具确认经 deriveRunStatus 投影为状态条视图模型,
 * 并接入基于 run.startedAt 的已用计时,再渲染纯展示的 RunStatusBar。
 *
 * 分层(对齐 Zed/Codex:状态投影与 presentation 解耦)——本组件只负责取数与计时,
 * 不含展示样式;无需呈现状态条时整体不渲染。
 */
const props = withDefaults(
  defineProps<{
    run: IAiAgentRun | null;
    confirmation: IAiToolConfirmationRequest | null;
    busy?: boolean;
  }>(),
  {
    busy: false,
  },
);

const emit = defineEmits<{
  pause: [];
  resume: [];
  cancel: [];
  resolve: [decision: TAiToolConfirmationDecision];
}>();

const viewModel = computed(() =>
  deriveRunStatus({ run: props.run, confirmation: props.confirmation }),
);

const elapsedSeconds = useElapsedSeconds(
  () => props.run?.startedAt ?? null,
  () => viewModel.value?.phase === 'running',
);

const handlePause = (): void => {
  emit('pause');
};

const handleResume = (): void => {
  emit('resume');
};

const handleCancel = (): void => {
  emit('cancel');
};

const handleResolve = (decision: TAiToolConfirmationDecision): void => {
  emit('resolve', decision);
};
</script>

<template>
  <RunStatusBar
    v-if="viewModel"
    :phase="viewModel.phase"
    :header="viewModel.header"
    :detail="viewModel.detail"
    :progress="viewModel.progress"
    :confirmation="viewModel.confirmation"
    :elapsed-seconds="elapsedSeconds"
    :can-pause="viewModel.canPause"
    :can-resume="viewModel.canResume"
    :can-cancel="viewModel.canCancel"
    :busy="busy"
    @pause="handlePause"
    @resume="handleResume"
    @cancel="handleCancel"
    @resolve="handleResolve"
  />
</template>
