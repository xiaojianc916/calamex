<script setup lang="ts">
import { ref } from 'vue';

import InlineError from '@/components/common/InlineError.vue';
import AiWebSearchActivity from '@/components/business/ai/AiWebSearchActivity.vue';
import AiWebSourceCard from '@/components/business/ai/AiWebSourceCard.vue';
import type { IAiWebActivity, IAiWebSourceEntry, TAiAgentNetworkPermission } from '@/types/ai';

const props = defineProps<{
  sources: readonly IAiWebSourceEntry[];
  activity: IAiWebActivity | null;
  errorMessage: string;
  isSearching: boolean;
  networkPermission: TAiAgentNetworkPermission;
}>();

const emit = defineEmits<{
  search: [query: string];
  fetchSource: [sourceId: string];
  clear: [];
}>();

const query = ref('');

const handleSearch = (): void => {
  const trimmed = query.value.trim();

  if (!trimmed || props.isSearching) {
    return;
  }

  emit('search', trimmed);
};
</script>

<template>
  <section class="ai-web-sources-panel" aria-label="Web Sources">
    <header class="ai-web-sources-header">
      <div class="ai-web-sources-title">
        <strong>Web Sources</strong>
        <span>{{ sources.length }} 个来源</span>
      </div>
      <button
        v-if="sources.length"
        type="button"
        class="ai-web-sources-clear"
        @click="emit('clear')"
      >
        清空
      </button>
    </header>

    <form class="ai-web-search-form" @submit.prevent="handleSearch">
      <input
        v-model="query"
        type="search"
        autocomplete="off"
        placeholder="搜索官方文档或错误信息"
        aria-label="搜索 Web Sources"
        :disabled="isSearching"
      />
      <button type="submit" :disabled="!query.trim() || isSearching">
        {{ isSearching ? '搜索中' : '搜索' }}
      </button>
    </form>

    <p v-if="networkPermission !== 'allowed-this-run'" class="ai-web-sources-hint">
      当前网络权限为 {{ networkPermission }}，搜索前请在顶部 Network 中允许本轮联网。
    </p>

    <AiWebSearchActivity :activity="activity" />
    <InlineError
      v-if="errorMessage"
      title="Web Sources 请求失败"
      :message="errorMessage"
      class="ai-web-sources-error"
    />

    <div v-if="sources.length" class="ai-web-source-list">
      <AiWebSourceCard
        v-for="source in sources"
        :key="source.id"
        :source="source"
        @fetch-source="emit('fetchSource', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.ai-web-sources-panel {
  display: grid;
  gap: 9px;
  border-top: 1px solid var(--shell-divider);
  padding: 10px 12px;
}

.ai-web-sources-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-web-sources-title {
  display: inline-flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.ai-web-sources-title strong {
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}

.ai-web-sources-title span {
  color: var(--text-quaternary);
  font-size: 11px;
}

.ai-web-sources-clear {
  height: 24px;
  border-radius: 6px;
  color: var(--text-quaternary);
  font-size: 11px;
  padding: 0 7px;
}

.ai-web-sources-clear:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}

.ai-web-search-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
}

.ai-web-search-form input {
  min-width: 0;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface-soft) 58%, transparent);
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
  padding: 0 9px;
}

.ai-web-search-form input::placeholder {
  color: var(--text-quaternary);
}

.ai-web-search-form input:focus {
  border-color: color-mix(in srgb, var(--accent-strong) 42%, var(--shell-divider));
}

.ai-web-search-form button {
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--accent-strong) 34%, var(--shell-divider));
  border-radius: 7px;
  background: color-mix(in srgb, var(--accent-strong) 14%, transparent);
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  padding: 0 10px;
  transition:
    color 120ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-web-search-form button:active:not(:disabled) {
  transform: scale(0.97);
}

.ai-web-search-form button:disabled,
.ai-web-search-form input:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.ai-web-sources-hint {
  margin: 0;
  font-size: 11px;
  line-height: 16px;
}

.ai-web-sources-hint {
  color: var(--text-quaternary);
}

.ai-web-sources-error {
  padding: 8px 10px;
}

.ai-web-source-list {
  display: grid;
  gap: 8px;
}
</style>
