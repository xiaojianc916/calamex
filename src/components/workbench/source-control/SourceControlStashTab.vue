<template>
  <section class="source-control-info-panel source-control-stash-panel">
    <div class="source-control-stash-header">
      <p class="source-control-stash-heading">贮藏</p>
      <p class="source-control-stash-summary"> stashPanelTitle </p>
    </div>

    <div class="source-control-stash-toolbar">
      <button type="button" class="source-control-btn source-control-btn-primary source-control-stash-toolbar-btn"
        :disabled="isStashesLoading || isBusy || totalChangeCount === 0" @click="handleSaveStash">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M19 14V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v8" />
          <path d="m5 14 7 4 7-4" />
        </svg>
        <span>贮藏当前改动</span>
      </button>

      <button type="button" class="source-control-btn source-control-stash-toolbar-btn"
        :disabled="isStashesLoading || isBusy" @click="handleReloadStashes">
        <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
        <span>刷新</span>
      </button>
    </div>

    <div v-if="isStashesLoading && filteredStashEntries.length === 0"
      class="source-control-info-note source-control-stash-note">
      正在读取 Git 贮藏…
    </div>

    <div v-else-if="filteredStashEntries.length > 0" class="source-control-stash-list">
      <article v-for="entry in filteredStashEntries" :key="entry.stashId" class="source-control-stash-item"
        :class="{ 'is-open': isStashOpen(entry.stashId) }">
        <button type="button" class="source-control-stash-head" :aria-expanded="isStashOpen(entry.stashId)"
          @click="toggleStashOpen(entry.stashId)">
          <span class="source-control-stash-ref"> resolveStashIndexLabel(entry) </span>

          <span class="source-control-stash-info">
            <span class="source-control-stash-title"> resolveStashTitle(entry) </span>
            <span class="source-control-stash-meta"> resolveStashMeta(entry) </span>
          </span>

          <svg class="source-control-stash-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>

        <div v-if="isStashOpen(entry.stashId)" class="source-control-stash-body">
          <div class="source-control-stash-details">
            <div class="source-control-stash-detail">
              <span class="source-control-stash-detail-label">引用</span>
              <span class="source-control-stash-detail-value"> entry.stashId </span>
            </div>

            <div v-if="entry.branchName" class="source-control-stash-detail">
              <span class="source-control-stash-detail-label">分支</span>
              <span class="source-control-stash-detail-value"> entry.branchName </span>
            </div>

            <div v-if="entry.commitShortId" class="source-control-stash-detail">
              <span class="source-control-stash-detail-label">基线</span>
              <span class="source-control-stash-detail-value"> entry.commitShortId </span>
            </div>
          </div>

          <div class="source-control-stash-actions">
            <button type="button" class="source-control-btn source-control-stash-action-btn" :disabled="isBusy"
              @click.stop="handleApplyStash(entry, false)">
              应用
            </button>
            <button type="button" class="source-control-btn source-control-stash-action-btn" :disabled="isBusy"
              @click.stop="handleApplyStash(entry, true)">
              应用并删除
            </button>
            <button type="button"
              class="source-control-btn source-control-stash-action-btn source-control-stash-action-btn-danger"
              :disabled="isBusy" @click.stop="handleDropStash(entry)">
              丢弃
            </button>
          </div>
        </div>
      </article>
    </div>

    <p v-else class="source-control-info-note source-control-stash-note"> stashEmptyText </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useDialog } from '@/composables/useDialog';
import { useMessage } from '@/composables/useMessage';
import { useGitStore } from '@/store/git';
import type { IGitStashEntryPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';

const props = defineProps<{
  searchQuery: string;
  isBusy: boolean;
  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;
}>();

const gitStore = useGitStore();
const message = useMessage();
const dialog = useDialog();

const status = computed(() => gitStore.status);
const stashEntries = computed<IGitStashEntryPayload[]>(() => gitStore.stashes);
const isStashesLoading = computed(() => gitStore.isStashesLoading);

const totalChangeCount = computed(
  () =>
    status.value.stagedCount +
    status.value.unstagedCount +
    status.value.untrackedCount +
    status.value.conflictedCount,
);

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

const filteredStashEntries = computed(() =>
  stashEntries.value.filter((entry) =>
    matchesSearchQuery([entry.stashId, entry.summary, entry.branchName]),
  ),
);

const activeStashId = ref<string | null | undefined>(undefined);

const resolvedOpenStashId = computed(() => {
  const firstEntry = filteredStashEntries.value[0];

  if (!firstEntry) {
    return null;
  }

  if (activeStashId.value === undefined) {
    return firstEntry.stashId;
  }

  return activeStashId.value;
});

watch(
  () => filteredStashEntries.value.map((entry) => entry.stashId),
  (stashIds) => {
    if (stashIds.length === 0) {
      activeStashId.value = undefined;
      return;
    }

    if (activeStashId.value && !stashIds.includes(activeStashId.value)) {
      activeStashId.value = undefined;
    }
  },
  { immediate: true },
);

const stashPanelTitle = computed(() => {
  if (props.searchQuery.trim()) {
    return `匹配 ${filteredStashEntries.value.length} 条`;
  }

  return stashEntries.value.length > 0 ? `共 ${stashEntries.value.length} 条` : '暂无贮藏';
});

const stashEmptyText = computed(() =>
  props.searchQuery.trim() ? '没有匹配的贮藏记录。' : '当前仓库没有 Git 贮藏。',
);

const STASH_SUMMARY_PREFIX_PATTERN = /^(?:On|WIP on)\s+[^:]+:\s*/u;

const resolveStashTitle = (entry: IGitStashEntryPayload): string => {
  const summary = entry.summary.trim();
  const normalized = summary.replace(STASH_SUMMARY_PREFIX_PATTERN, '').trim();

  return normalized || summary;
};

const resolveStashIndexLabel = (entry: IGitStashEntryPayload): string => `@${entry.index}`;

const resolveStashMeta = (entry: IGitStashEntryPayload): string => {
  const segments: string[] = [];

  if (entry.branchName) {
    segments.push(entry.branchName);
  }
  if (entry.commitShortId) {
    segments.push(entry.commitShortId);
  }

  if (segments.length === 0) {
    segments.push(entry.stashId);
  }

  return segments.join(' · ');
};

const isStashOpen = (stashId: string): boolean => resolvedOpenStashId.value === stashId;

const toggleStashOpen = (stashId: string): void => {
  activeStashId.value = isStashOpen(stashId) ? null : stashId;
};

const promptForText = (title: string, defaultValue = ''): string | null => {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    return null;
  }

  return window.prompt(title, defaultValue);
};

const handleReloadStashes = async (): Promise<void> => {
  try {
    await gitStore.loadStashes();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Git 贮藏失败'));
  }
};

const handleSaveStash = async (): Promise<void> => {
  const stashMessageInput = promptForText('输入可选的贮藏说明；留空则使用 Git 默认说明。', '');
  if (stashMessageInput === null) {
    return;
  }

  const stashMode = await dialog.confirm({
    title: '是否同时保存未跟踪文件？',
    description: '确认会把未跟踪文件也放入 stash；取消则只保存已跟踪改动。',
    confirmText: '包含未跟踪',
    cancelText: '仅已跟踪',
    dismissText: '取消',
    variant: 'default',
  });
  if (stashMode === 'dismiss') {
    return;
  }

  const includeUntracked = stashMode === 'confirm';
  const stashMessage = stashMessageInput.trim() || null;

  try {
    const didRun = await props.runWithPending('save-stash', async () => {
      await gitStore.saveStash(stashMessage, includeUntracked);
      await gitStore.loadStashes();
    });

    if (!didRun) {
      return;
    }

    message.success('当前改动已保存到 Git 贮藏');
  } catch (error) {
    message.error(toErrorMessage(error, '保存 Git 贮藏失败'));
  }
};

const handleApplyStash = async (entry: IGitStashEntryPayload, pop: boolean): Promise<void> => {
  if (pop) {
    const action = await dialog.confirm({
      title: '弹出此贮藏？',
      description: `将应用 ${entry.stashId} 的改动并从贮藏列表移除。`,
      confirmText: '弹出',
      cancelText: '取消',
      variant: 'danger',
    });
    if (action !== 'confirm') {
      return;
    }
  }

  try {
    const didRun = await props.runWithPending(
      `${pop ? 'pop' : 'apply'}-stash:${entry.stashId}`,
      async () => {
        await gitStore.applyStash(entry.index, pop);
        await gitStore.loadStashes();
      },
    );

    if (!didRun) {
      return;
    }

    message.success(pop ? `已弹出 ${entry.stashId}` : `已应用 ${entry.stashId}`);
  } catch (error) {
    message.error(toErrorMessage(error, pop ? '弹出 Git 贮藏失败' : '应用 Git 贮藏失败'));
  }
};

const handleDropStash = async (entry: IGitStashEntryPayload): Promise<void> => {
  const action = await dialog.confirm({
    title: '删除此贮藏？',
    description: `将永久删除 ${entry.stashId}。此操作无法撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    variant: 'danger',
  });
  if (action !== 'confirm') {
    return;
  }

  try {
    const didRun = await props.runWithPending(`drop-stash:${entry.stashId}`, async () => {
      await gitStore.dropStash(entry.index);
      await gitStore.loadStashes();
    });

    if (!didRun) {
      return;
    }

    message.success(`已删除 ${entry.stashId}`);
  } catch (error) {
    message.error(toErrorMessage(error, '删除 Git 贮藏失败'));
  }
};
</script>
