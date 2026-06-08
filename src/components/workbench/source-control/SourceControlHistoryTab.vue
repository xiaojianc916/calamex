<template>
  <section class="source-control-info-panel source-control-history-panel">
    <div class="source-control-history-header">
      <p class="source-control-history-heading">History</p>
      <div class="source-control-history-header-actions">
        <button type="button" class="source-control-history-refresh" aria-label="刷新历史" title="刷新历史"
          :disabled="isCommitHistoryLoading || isBusy" @click="handleReloadCommitHistory">
          <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
        </button>
        <p class="source-control-history-summary" v-text="historyPanelTitle" />
      </div>
    </div>

    <div v-if="isCommitHistoryLoading && filteredCommitHistory.length === 0"
      class="source-control-info-note source-control-history-note">
      正在读取 Git 提交历史…
    </div>

    <GitHistoryGraph
      v-else-if="filteredCommitHistory.length > 0"
      :commits="filteredCommitHistory"
      :ahead="status.ahead"
      :behind="status.behind"
    />

    <p v-else class="source-control-info-note source-control-history-note" v-text="historyEmptyText" />
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import GitHistoryGraph from '@/components/workbench/GitHistoryGraph.vue';
import { useMessage } from '@/composables/useMessage';
import { useGitStore } from '@/store/git';
import type { IGitCommitSummaryPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';

const props = defineProps<{
  searchQuery: string;
  isBusy: boolean;
}>();

const gitStore = useGitStore();
const message = useMessage();

const status = computed(() => gitStore.status);
const commitHistoryEntries = computed<IGitCommitSummaryPayload[]>(() => gitStore.commitHistory);
const isCommitHistoryLoading = computed(() => gitStore.isCommitHistoryLoading);

const matchesSearchQuery = (parts: Array<string | null | undefined>): boolean => {
  const keyword = props.searchQuery.trim().toLowerCase();
  if (!keyword) {
    return true;
  }

  return parts
    .filter((value): value is string => Boolean(value && value.trim().length > 0))
    .join(' ')
    .toLowerCase()
    .includes(keyword);
};

const filteredCommitHistory = computed(() =>
  commitHistoryEntries.value.filter((entry) =>
    matchesSearchQuery([entry.summary, entry.shortId, entry.authorName]),
  ),
);

const historyPanelTitle = computed(() => {
  if (props.searchQuery.trim()) {
    return `匹配 ${filteredCommitHistory.value.length} 条`;
  }

  const visibleCount = commitHistoryEntries.value.length || (status.value.lastCommit ? 1 : 0);

  if (visibleCount > 0) {
    return `最近 ${visibleCount} 条`;
  }

  return isCommitHistoryLoading.value ? '正在同步' : '暂无提交';
});

const historyEmptyText = computed(() =>
  props.searchQuery.trim() ? '没有匹配的提交记录。' : '当前仓库还没有提交记录。',
);

const handleReloadCommitHistory = async (): Promise<void> => {
  try {
    await gitStore.loadCommitHistory();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Git 提交历史失败'));
  }
};
</script>
