<script setup lang="ts">
import { RotateCcw, ShieldAlert } from '@lucide/vue';
import { computed, ref } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { Button } from '@/components/ui/button';
import { writeClipboardText } from '@/utils/platform/clipboard';

const props = withDefaults(
  defineProps<{
    title: string;
    message: string;
    detail?: string;
    code?: string;
    traceId?: string;
  }>(),
  {
    detail: undefined,
    code: undefined,
    traceId: undefined,
  },
);

const copyState = ref<'idle' | 'copied' | 'failed'>('idle');

const diagnosticText = computed(() =>
  [
    props.title,
    props.message,
    props.code ? `code=${props.code}` : null,
    props.traceId ? `traceId=${props.traceId}` : null,
    props.detail,
  ]
    .filter(Boolean)
    .join('\n\n'),
);

const reloadWindow = (): void => {
  window.location.reload();
};

const copyDiagnostics = async (): Promise<void> => {
  try {
    await writeClipboardText(diagnosticText.value);
    copyState.value = 'copied';
  } catch {
    copyState.value = 'failed';
  }
};
</script>

<template>
  <section class="app-fatal-error" role="alert" aria-live="assertive">
    <div class="app-fatal-error__panel">
      <div class="app-fatal-error__icon">
        <ShieldAlert class="size-5" />
      </div>
      <div class="app-fatal-error__content">
        <h1 class="app-fatal-error__title">{{ props.title }}</h1>
        <p class="app-fatal-error__message">{{ props.message }}</p>
        <div v-if="props.code || props.traceId" class="app-fatal-error__meta">
          <span v-if="props.code">code={{ props.code }}</span>
          <span v-if="props.traceId">traceId={{ props.traceId }}</span>
        </div>
        <div class="app-fatal-error__actions">
          <Button size="sm" class="h-8 px-3 text-[12px]" @click="reloadWindow">
            <RotateCcw class="size-3.5" />
            重新加载界面
          </Button>
          <Button
            v-if="props.detail"
            variant="outline"
            size="sm"
            class="h-8 px-3 text-[12px]"
            @click="copyDiagnostics"
          >
            {{
              copyState === 'copied'
                ? '已复制'
                : copyState === 'failed'
                  ? '复制失败'
                  : '复制诊断信息'
            }}
          </Button>
        </div>
        <ErrorDetails
          v-if="props.detail"
          class="app-fatal-error__details"
          :details="props.detail"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.app-fatal-error {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-0);
  color: var(--text-primary);
}

.app-fatal-error__panel {
  display: grid;
  width: min(780px, 100%);
  grid-template-columns: auto minmax(0, 1fr);
  gap: 14px;
  border: 1px solid color-mix(in srgb, var(--danger) 34%, var(--border-subtle));
  border-radius: var(--radius-lg);
  background: var(--bg-1);
  padding: 20px 24px;
  box-shadow: 0 24px 72px color-mix(in srgb, var(--text-quaternary) 36%, transparent);
}

.app-fatal-error__icon {
  display: flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--danger) 28%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.app-fatal-error__content {
  min-width: 0;
}

.app-fatal-error__title {
  margin: 0;
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 600;
}

.app-fatal-error__message {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.7;
}

.app-fatal-error__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 10px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.app-fatal-error__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.app-fatal-error__details {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .app-fatal-error__panel {
    grid-template-columns: minmax(0, 1fr);
    padding: 18px;
  }
}
</style>
