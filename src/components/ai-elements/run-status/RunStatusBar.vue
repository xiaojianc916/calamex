<script setup lang="ts">
import { computed } from 'vue';

import { Button } from '@/components/ui/button';
import type {
  IAiToolConfirmationOption,
  IAiToolConfirmationRequest,
  TAiToolConfirmationDecision,
} from '@/types/ai';

import { formatElapsedCompact } from './format-elapsed';

type TRunStatusPhase = 'running' | 'paused' | 'awaiting-confirmation';

interface IRunStatusProgress {
  done: number;
  total: number;
}

const props = withDefaults(
  defineProps<{
    phase: TRunStatusPhase;
    header: string;
    elapsedSeconds?: number;
    detail?: string | null;
    progress?: IRunStatusProgress | null;
    confirmation?: IAiToolConfirmationRequest | null;
    canPause?: boolean;
    canResume?: boolean;
    canCancel?: boolean;
    busy?: boolean;
  }>(),
  {
    elapsedSeconds: 0,
    detail: null,
    progress: null,
    confirmation: null,
    canPause: false,
    canResume: false,
    canCancel: false,
    busy: false,
  },
);

const emit = defineEmits<{
  pause: [];
  resume: [];
  cancel: [];
  resolve: [decision: TAiToolConfirmationDecision];
}>();

const isAwaitingConfirmation = computed(
  () => props.phase === 'awaiting-confirmation' && props.confirmation !== null,
);
const isPaused = computed(() => props.phase === 'paused');
const isRunning = computed(() => props.phase === 'running');

const elapsedLabel = computed(() => formatElapsedCompact(props.elapsedSeconds));

const progressLabel = computed(() => {
  const progress = props.progress;

  if (!progress || progress.total <= 0) {
    return null;
  }

  const done = Math.max(0, Math.min(progress.done, progress.total));
  return `${done}/${progress.total}`;
});

const headerText = computed(() => {
  const confirmation = props.confirmation;

  if (isAwaitingConfirmation.value && confirmation) {
    return confirmation.summary.trim() || confirmation.toolName;
  }

  return props.header;
});

const detailText = computed(() => {
  const confirmation = props.confirmation;

  if (isAwaitingConfirmation.value && confirmation) {
    const impact = confirmation.impact?.trim();
    return impact || null;
  }

  const detail = props.detail?.trim();
  return detail ? detail : null;
});

const confirmationOptions = computed<IAiToolConfirmationOption[]>(() => {
  const confirmation = props.confirmation;

  if (!confirmation) {
    return [];
  }

  return confirmation.options.filter(
    (option) => option.id === 'allow-once' || option.id === 'stop',
  );
});

const optionVariant = (option: IAiToolConfirmationOption): 'default' | 'outline' | 'ghost' => {
  if (option.tone === 'primary') {
    return 'default';
  }

  if (option.tone === 'danger') {
    return 'outline';
  }

  return 'ghost';
};

const handlePause = (): void => {
  emit('pause');
};

const handleResume = (): void => {
  emit('resume');
};

const handleCancel = (): void => {
  emit('cancel');
};

const handleResolve = (option: IAiToolConfirmationOption): void => {
  emit('resolve', option.id);
};
</script>

<template>
  <div
    class="run-status"
    :class="{
      'is-running': isRunning,
      'is-paused': isPaused,
      'is-awaiting': isAwaitingConfirmation,
    }"
    role="status"
    aria-live="polite"
  >
    <div class="run-status__line">
      <span class="run-status__icon" aria-hidden="true">
        <span
          v-if="isPaused"
          class="run-status__glyph icon-[lucide--circle-pause]"
        />
        <span
          v-else
          class="run-status__glyph icon-[lucide--loader-circle] animate-spin"
        />
      </span>

      <span class="run-status__header" v-text="headerText" />

      <span v-if="!isAwaitingConfirmation" class="run-status__meta">
        <span class="run-status__elapsed" v-text="elapsedLabel" />
        <span v-if="progressLabel" class="run-status__dot" aria-hidden="true">·</span>
        <span v-if="progressLabel" class="run-status__progress" v-text="progressLabel" />
      </span>

      <span class="run-status__spacer" />

      <span class="run-status__actions">
        <template v-if="isAwaitingConfirmation">
          <Button
            v-for="option in confirmationOptions"
            :key="option.id"
            :variant="optionVariant(option)"
            size="sm"
            class="run-status__btn"
            :disabled="busy"
            @click="handleResolve(option)"
          >
            <span v-text="option.label" />
          </Button>
        </template>
        <template v-else>
          <Button
            v-if="isPaused && canResume"
            variant="ghost"
            size="sm"
            class="run-status__btn"
            :disabled="busy"
            aria-label="继续"
            @click="handleResume"
          >
            <span class="run-status__btn-glyph icon-[lucide--play]" aria-hidden="true" />
            <span class="run-status__btn-label">继续</span>
          </Button>
          <Button
            v-else-if="canPause"
            variant="ghost"
            size="sm"
            class="run-status__btn"
            :disabled="busy"
            aria-label="暂停"
            @click="handlePause"
          >
            <span class="run-status__btn-glyph icon-[lucide--pause]" aria-hidden="true" />
            <span class="run-status__btn-label">暂停</span>
          </Button>
          <Button
            v-if="canCancel"
            variant="ghost"
            size="sm"
            class="run-status__btn is-danger"
            :disabled="busy"
            aria-label="取消"
            @click="handleCancel"
          >
            <span class="run-status__btn-glyph icon-[lucide--x]" aria-hidden="true" />
            <span class="run-status__btn-label">取消</span>
          </Button>
        </template>
      </span>
    </div>

    <p v-if="detailText" class="run-status__detail">
      <span class="run-status__branch" aria-hidden="true">└</span>
      <span class="run-status__detail-text" :title="detailText" v-text="detailText" />
    </p>
  </div>
</template>

<style scoped>
.run-status {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 6px 10px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 18px;
}

.run-status__line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.run-status__icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--accent-strong);
}

.run-status__glyph {
  width: 14px;
  height: 14px;
}

.run-status__header {
  min-width: 0;
  max-width: 18rem;
  overflow: hidden;
  color: var(--text-primary);
  font-weight: 450;
  letter-spacing: -0.01em;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.run-status.is-running .run-status__header {
  background: linear-gradient(
    90deg,
    var(--text-secondary) 0%,
    var(--text-primary) 50%,
    var(--text-secondary) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: run-status-shimmer 2.4s linear infinite;
}

.run-status__meta {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.run-status__spacer {
  flex: 1 1 auto;
}

.run-status__actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.run-status__btn {
  height: 26px;
  gap: 4px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 400;
}

.run-status__btn-glyph {
  width: 13px;
  height: 13px;
}

.run-status__btn.is-danger {
  color: var(--danger);
}

.run-status__detail {
  display: flex;
  gap: 6px;
  margin: 0;
  padding-left: 22px;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 16px;
}

.run-status__branch {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  opacity: 0.7;
}

.run-status__detail-text {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
}

@keyframes run-status-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .run-status__glyph.animate-spin {
    animation: none;
  }

  .run-status.is-running .run-status__header {
    animation: none;
    background: none;
    -webkit-text-fill-color: var(--text-primary);
    color: var(--text-primary);
  }
}
</style>
