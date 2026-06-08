<script setup lang="ts">
import Checkpoint from '@/components/ai-elements/checkpoint/Checkpoint.vue';
import CheckpointIcon from '@/components/ai-elements/checkpoint/CheckpointIcon.vue';
import CheckpointTrigger from '@/components/ai-elements/checkpoint/CheckpointTrigger.vue';
import { Loader } from '@/components/ai-elements/loader';

defineProps<{
  label: string;
  disabled: boolean;
  restoring: boolean;
}>();

const emit = defineEmits<{
  restore: [];
}>();
</script>

<template>
  <Checkpoint class="ai-conversation-checkpoint">
    <CheckpointTrigger class="ai-conversation-checkpoint__trigger" :disabled="disabled" @click="emit('restore')">
      <CheckpointIcon class="ai-conversation-checkpoint__icon" aria-hidden="true" />
      <span class="ai-conversation-checkpoint__label" v-text="label"></span>
      <Loader v-if="restoring" class="ai-conversation-checkpoint__loader" :size="12" />
      <span v-else class="ai-conversation-checkpoint__spacer" aria-hidden="true"></span>
    </CheckpointTrigger>
  </Checkpoint>
</template>

<style scoped>
.ai-conversation-checkpoint {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 0 0;
  color: var(--text-quaternary);
}

.ai-conversation-checkpoint__trigger {
  display: inline-grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 6px;
  height: auto;
  border: 0;
  padding: 0 2px;
  color: inherit;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}

.ai-conversation-checkpoint__label {
  text-align: center;
}

.ai-conversation-checkpoint__trigger:hover {
  color: var(--text-secondary);
}

.ai-conversation-checkpoint__trigger:disabled {
  cursor: default;
  opacity: 0.72;
}

.ai-conversation-checkpoint__icon,
.ai-conversation-checkpoint__loader,
.ai-conversation-checkpoint__spacer {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}
</style>
