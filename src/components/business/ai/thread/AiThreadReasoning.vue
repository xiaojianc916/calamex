<script setup lang="ts">
import { Brain, BrainCircuit } from '@lucide/vue';
import { computed, ref, watch } from 'vue';
import { ThreadEntryDisclosure } from '@/components/ai-elements/thread-entry';
import AiMarkdown from '@/components/business/ai/chat/AiMarkdown.vue';
import type { IAiChatStreamRenderState } from '@/types/ai';
import type { IAiThreadReasoningEntry } from './projection';
import { useElapsedSeconds } from './useElapsedSeconds';

const props = defineProps<{
  entry: IAiThreadReasoningEntry;
  open: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const title = computed(() => (props.entry.streaming ? '正在推理…' : '推理'));

const reasoningText = computed(() =>
  props.entry.segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('\n\n'),
);

const streamStatus = computed<IAiChatStreamRenderState['status'] | undefined>(() =>
  props.entry.streaming ? 'streaming' : undefined,
);

// 推理用时(Thought for Ns):投影为纯 UI、不携带 wire 时间戳,故以本会话首次观察到
// streaming 的墙钟时刻为近似起点,交由 useElapsedSeconds 在流式期间逐秒滴答、停流后
// 冻结(对齐 Codex status indicator 取向)。历史重载(从未流式)不显示计时,避免臆造时长。
const reasoningStartedAt = ref<string | null>(null);
const sawStreaming = ref(false);

watch(
  () => props.entry.streaming,
  (streaming) => {
    if (streaming && reasoningStartedAt.value === null) {
      reasoningStartedAt.value = new Date().toISOString();
      sawStreaming.value = true;
    }
  },
  { immediate: true },
);

const elapsedSeconds = useElapsedSeconds(
  () => reasoningStartedAt.value,
  () => props.entry.streaming,
);

const showElapsed = computed(() => sawStreaming.value && elapsedSeconds.value > 0);
</script>

<template>
  <ThreadEntryDisclosure
    class="ai-thread-reasoning"
    :open="open"
    :title="title"
    @update:open="emit('update:open', $event)"
  >
    <template #leading>
      <!-- 流式推理用强调色(--accent)做活跃提示;收口自原 text-blue-500 硬编码,改由设计 token 驱动,随主题/One Light 作用域联动。 -->
      <BrainCircuit
        class="size-4"
        :style="{ color: 'var(--accent)' }"
        v-if="entry.streaming"
        aria-hidden="true"
      />
      <Brain class="size-4 text-muted-foreground" v-else aria-hidden="true" />
    </template>
    <template #title>
      <!-- 流式时标题做微光流转(shimmer),与“正在推理…”活跃态呼应;完成后回到静态前景色。 -->
      <span
        class="ai-thread-reasoning__title"
        :class="{ 'is-streaming': entry.streaming }"
        v-text="title"
      />
    </template>
    <template #meta>
      <span
        v-if="showElapsed"
        class="ai-thread-reasoning__elapsed"
        :title="'推理用时'"
        v-text="`用时 ${elapsedSeconds}s`"
      />
    </template>
    <template #content>
      <AiMarkdown
        class="ai-thread-reasoning__text"
        :message-id="`${entry.messageId}:reasoning`"
        :content="reasoningText"
        :stream-status="streamStatus"
      />
    </template>
  </ThreadEntryDisclosure>
</template>

<style scoped>
/* 流式微光:文字渐变在 muted↔前景间往复流转,纯装饰;completed 态回到静态前景色。 */
.ai-thread-reasoning__title.is-streaming {
  background: linear-gradient(
    90deg,
    var(--text-tertiary, #9b9b9b) 25%,
    var(--text-primary, #2b2b2b) 50%,
    var(--text-tertiary, #9b9b9b) 75%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: ai-thread-reasoning-shimmer 1.6s linear infinite;
}

@keyframes ai-thread-reasoning-shimmer {
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-thread-reasoning__title.is-streaming {
    animation: none;
  }
}

.ai-thread-reasoning__elapsed {
  flex: 0 0 auto;
  color: var(--text-tertiary, #6b7280);
  font-variant-numeric: tabular-nums;
}

.ai-thread-reasoning__text {
  color: var(--text-tertiary, #6b7280);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
</style>
