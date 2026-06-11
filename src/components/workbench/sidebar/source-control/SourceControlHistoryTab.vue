<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import { computed } from 'vue';
import { useGitStore } from '@/store/git';
import type { IGitCommitSummaryPayload } from '@/types/git';
import GitHistoryGraph from './GitHistoryGraph.vue';

const props = defineProps<{ searchQuery: string; isBusy: boolean }>();

const gitStore = useGitStore();

const matchesSearchQuery = (commit: IGitCommitSummaryPayload, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    commit.summary.toLowerCase().includes(needle) ||
    commit.shortId.toLowerCase().includes(needle) ||
    commit.id.toLowerCase().includes(needle) ||
    commit.authorName.toLowerCase().includes(needle)
  );
};

const filteredCommitHistory = computed<IGitCommitSummaryPayload[]>(() =>
  gitStore.commitHistory.filter((commit) => matchesSearchQuery(commit, props.searchQuery)),
);

const historyPanelTitle = computed<string>(() => `历史记录 (${filteredCommitHistory.value.length})`);

const historyEmptyText = computed<string>(() =>
  props.searchQuery.trim() ? '没有匹配的提交' : '暂无提交记录',
);

const handleReloadCommitHistory = (): void => {
  void gitStore.loadCommitHistory().catch((error) => {
    console.error('[SourceControlHistoryTab] reload commit history failed:', error);
  });
};
</script>

<template>
  <div class="source-control-history-tab">
    <header class="source-control-history-tab-header">
      <span class="source-control-history-tab-title" v-text="historyPanelTitle" />
      <button
        type="button"
        class="source-control-history-tab-reload"
        :disabled="isBusy"
        title="重新加载历史"
        aria-label="重新加载历史"
        @click="handleReloadCommitHistory"
      >
        <RefreshCw :class="{ 'is-spinning': isBusy }" aria-hidden="true" />
      </button>
    </header>

    <GitHistoryGraph
      v-if="filteredCommitHistory.length > 0"
      :commits="filteredCommitHistory"
      :ahead="gitStore.status.ahead"
      :behind="gitStore.status.behind"
    />
    <p v-else class="source-control-history-tab-empty" v-text="historyEmptyText" />
  </div>
</template>
