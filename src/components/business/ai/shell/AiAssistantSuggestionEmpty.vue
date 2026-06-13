<script setup lang="ts">
interface IAiSuggestionItem {
  title: string;
  message: string;
}

defineProps<{
  suggestionRows: IAiSuggestionItem[][];
  disabled: boolean;
}>();

const emit = defineEmits<{
  select: [message: string];
}>();
</script>

<template>
  <div class="ai-suggestion-empty">
    <h2 class="ai-suggestion-greeting">有什么我能帮你的吗？</h2>
    <div v-for="(suggestionRow, rowIndex) in suggestionRows" :key="rowIndex" class="ai-suggestion-row">
      <button
        v-for="suggestion in suggestionRow"
        :key="suggestion.message"
        type="button"
        class="ai-suggestion-chip"
        :disabled="disabled"
        @click="emit('select', suggestion.message)"
        v-text="suggestion.title"
      ></button>
    </div>
  </div>
</template>

<style scoped>
.ai-suggestion-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 6px;
  padding: 0 16px 0;
}

.ai-suggestion-greeting {
  margin: 0 0 18px;
  color: var(--text-primary);
  font-size: 26px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.01em;
  text-align: center;
}

.ai-suggestion-row {
  display: flex;
  max-width: 100%;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px 10px;
}

.ai-suggestion-chip {
  display: inline-flex;
  min-width: 0;
  max-width: min(100%, 360px);
  min-height: 34px;
  flex: 0 1 auto;
  align-items: center;
  justify-content: center;
  border: 0 !important;
  border-radius: var(--radius-md) !important;
  background-color: color-mix(in srgb, var(--surface-soft) 62%, transparent) !important;
  color: var(--text-secondary) !important;
  cursor: pointer;
  font-size: 13px !important;
  font-weight: 500 !important;
  line-height: 18px;
  padding: 7px 17px !important;
  text-align: center;
  box-shadow: none !important;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-emphasized),
    color var(--motion-duration-fast) var(--motion-easing-emphasized),
    transform var(--motion-duration-fast) var(--motion-easing-emphasized);
}

.ai-suggestion-chip:hover {
  background-color: color-mix(in srgb, var(--surface-soft) 100%, transparent) !important;
  color: var(--text-primary) !important;
}

.ai-suggestion-chip:active {
  transform: scale(0.985);
}

.ai-suggestion-chip:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 44%, transparent);
  outline-offset: 3px;
}

.ai-suggestion-chip:disabled {
  cursor: default;
  opacity: 0.58;
}
</style>
