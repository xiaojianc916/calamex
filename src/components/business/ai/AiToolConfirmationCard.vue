<script setup lang="ts">
import { computed, ref } from 'vue';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type {
  IAiToolConfirmationOption,
  IAiToolConfirmationRequest,
  TAiToolConfirmationDecision,
} from '@/types/ai';

const props = defineProps<{
  confirmation: IAiToolConfirmationRequest;
  disabled: boolean;
}>();

const emit = defineEmits<{
  resolve: [decision: TAiToolConfirmationDecision];
}>();

const isDetailExpanded = ref(false);

const visibleOptions = computed(() =>
  props.confirmation.options.filter((option) => option.id === 'allow-once' || option.id === 'stop'),
);

const canToggleDetails = computed(() => Boolean(props.confirmation.impact?.trim()));
const detailPreview = computed(() =>
  props.confirmation.impact?.trim() || props.confirmation.summary.trim() || props.confirmation.toolName,
);
const riskLabel = computed(() => {
  switch (props.confirmation.riskLevel) {
    case 'high':
      return '高风险';
    case 'medium':
      return '中风险';
    case 'low':
      return '低风险';
    default:
      return '风险未知';
  }
});

const riskDescription = computed(() =>
  props.confirmation.reversible
    ? `${riskLabel.value}，允许后可回滚。`
    : `${riskLabel.value}，请确认后继续。`,
);

const getOptionVariant = (option: IAiToolConfirmationOption): 'default' | 'outline' | 'ghost' => {
  const tone = option.tone ?? 'secondary';

  switch (tone) {
    case 'primary':
      return 'default';
    case 'danger':
      return 'outline';
    default:
      return 'ghost';
  }
};

const getOptionClass = (option: IAiToolConfirmationOption): string =>
  option.tone === 'danger' ? 'ai-tool-confirmation-option is-danger' : 'ai-tool-confirmation-option';

const toggleDetails = (): void => {
  isDetailExpanded.value = !isDetailExpanded.value;
};

const handleOptionClick = (option: IAiToolConfirmationOption): void => {
  if (option.id === 'view-details') {
    toggleDetails();
    return;
  }

  emit('resolve', option.id);
};
</script>

<template>
  <Card class="ai-tool-confirmation-card" aria-label="工具执行确认">
    <div class="ai-tool-confirmation-risk-mark" :aria-label="riskDescription">
      <svg class="ai-tool-confirmation-risk-mark__umbrella" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 13a9 9 0 0 1 18 0" />
        <path d="M12 4v17" />
        <path d="M12 21a3 3 0 0 0 3-3" />
        <path d="M6.6 13a3.6 3.6 0 0 1 5.4 0" />
        <path d="M12 13a3.6 3.6 0 0 1 5.4 0" />
      </svg>
      <span class="ai-tool-confirmation-risk-mark__shield">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3.5 19 6v5.2c0 4.4-2.8 7.4-7 9.3-4.2-1.9-7-4.9-7-9.3V6l7-2.5Z" />
          <path d="M12 8v5" />
          <path d="M12 16.5h.01" />
        </svg>
      </span>
    </div>

    <div class="ai-tool-confirmation-copy">
      <h3 class="ai-tool-confirmation-title">
        {{ confirmation.question }}
      </h3>
      <p class="ai-tool-confirmation-summary">
        <span>{{ confirmation.summary }}</span>
        <button
          v-if="canToggleDetails"
          type="button"
          class="ai-tool-confirmation-learn-more"
          :aria-expanded="isDetailExpanded"
          @click="toggleDetails"
        >
          了解更多
        </button>
      </p>
      <div class="ai-tool-confirmation-detail-row">
        <code
          class="ai-tool-confirmation-detail"
          :class="{ 'is-expanded': isDetailExpanded }"
          :title="detailPreview"
        >
          {{ detailPreview }}
        </code>
        <button
          v-if="canToggleDetails"
          type="button"
          class="ai-tool-confirmation-detail-toggle"
          :aria-expanded="isDetailExpanded"
          @click="toggleDetails"
        >
          {{ isDetailExpanded ? '收起' : '全部显示' }}
        </button>
      </div>
    </div>

    <div class="ai-tool-confirmation-actions">
      <Button
        v-for="option in visibleOptions"
        :key="option.id"
        :variant="getOptionVariant(option)"
        size="sm"
        :class="getOptionClass(option)"
        :disabled="disabled"
        @click="handleOptionClick(option)"
      >
        {{ option.label }}
      </Button>
    </div>
  </Card>
</template>

<style scoped>
.ai-tool-confirmation-card {
  display: grid;
  gap: 12px;
  width: min(100%, 504px);
  border-color: color-mix(in srgb, var(--border-subtle) 72%, transparent);
  border-radius: 12px;
  background: var(--panel-bg);
  padding: 20px 21px 17px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 5%, transparent);
  transition:
    opacity 160ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-confirmation-risk-mark {
  position: relative;
  width: 28px;
  height: 25px;
  color: var(--text-secondary);
}

.ai-tool-confirmation-risk-mark__umbrella {
  width: 20px;
  height: 20px;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.9;
}

.ai-tool-confirmation-risk-mark__shield {
  position: absolute;
  right: 1px;
  bottom: 0;
  display: grid;
  width: 14px;
  height: 14px;
  place-items: center;
  border-radius: 4px;
  background: var(--danger);
  color: var(--panel-bg);
}

.ai-tool-confirmation-risk-mark__shield svg {
  width: 9px;
  height: 9px;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 2.1;
}

.ai-tool-confirmation-copy {
  display: grid;
  min-width: 0;
  gap: 7px;
}

.ai-tool-confirmation-title {
  margin: 0;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 450;
  letter-spacing: -0.02em;
  line-height: 18px;
}

.ai-tool-confirmation-summary {
  margin: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 17px;
}

.ai-tool-confirmation-learn-more {
  border: 0;
  padding: 0 0 0 6px;
  color: var(--accent-strong);
}

.ai-tool-confirmation-learn-more:hover {
  color: color-mix(in srgb, var(--accent-strong) 78%, var(--text-primary));
}

.ai-tool-confirmation-detail-row {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
}

.ai-tool-confirmation-detail {
  min-width: 0;
  overflow: hidden;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 400;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-tool-confirmation-detail.is-expanded {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  word-break: break-word;
}

.ai-tool-confirmation-detail-toggle {
  border: 0;
  padding: 0;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 16px;
  white-space: nowrap;
}

.ai-tool-confirmation-detail-toggle:hover {
  color: var(--text-primary);
}

.ai-tool-confirmation-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 3px;
}

.ai-tool-confirmation-option {
  min-width: 76px;
  border-color: transparent;
  background: var(--surface-soft);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 400;
}

.ai-tool-confirmation-option:hover {
  background: var(--surface-hover);
}

.ai-tool-confirmation-option.is-danger {
  border-color: transparent;
  background: var(--surface-soft);
  color: var(--danger);
}

.ai-tool-confirmation-option.is-danger:hover {
  background: color-mix(in srgb, var(--danger) 9%, var(--surface-hover));
}

@media (prefers-reduced-motion: reduce) {
  .ai-tool-confirmation-card {
    transition: none;
  }
}

@media (max-width: 720px) {
  .ai-tool-confirmation-card {
    padding: 16px 14px 14px;
  }

  .ai-tool-confirmation-detail-row {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .ai-tool-confirmation-detail-toggle {
    justify-self: start;
  }
}
</style>
