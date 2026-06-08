<template>
  <section class="source-control-info-panel source-control-branches-panel">
    <div class="source-control-branches-header">
      <p class="source-control-branches-heading">Branches</p>
      <div class="source-control-branches-header-actions">
        <button type="button" class="source-control-branches-refresh" aria-label="刷新分支" title="刷新分支"
          :disabled="isBranchesLoading || isBusy" @click="handleReloadBranches">
          <span aria-hidden="true" class="icon-[lucide--refresh-cw]" />
        </button>
        <p class="source-control-branches-summary"> branchesPanelSummary </p>
      </div>
    </div>

    <p v-if="status.isDetached" class="source-control-info-note source-control-branches-detached">
      当前处于 detached HEAD，切换分支前请确认工作区已处理干净。
    </p>

    <div class="source-control-branch-create">
      <button v-if="!isBranchCreateOpen" type="button" class="source-control-branch-create-trigger"
        :disabled="isBusy" @click="openBranchCreate">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>新建分支</span>
      </button>

      <form v-else class="source-control-branch-create-form" @submit.prevent="submitBranchCreate">
        <input ref="branchNameInputRef" v-model="branchCreateName" type="text"
          class="source-control-branch-create-input" :class="{ 'is-invalid': Boolean(branchCreateError) }"
          placeholder="新分支名称，基于当前 HEAD" :disabled="isBusy" autocomplete="off" spellcheck="false"
          @input="branchCreateError = null" @keydown.esc.prevent="cancelBranchCreate" />

        <div class="source-control-branch-create-actions">
          <button type="button" class="source-control-branch-create-btn" :disabled="isBusy"
            @click="cancelBranchCreate">
            取消
          </button>
          <button type="submit"
            class="source-control-branch-create-btn source-control-branch-create-btn-primary"
            :disabled="isBusy || branchCreateName.trim().length === 0">
            创建并切换
          </button>
        </div>

        <p v-if="branchCreateError" class="source-control-branch-create-error"> branchCreateError </p>
      </form>
    </div>

    <div v-if="isBranchesLoading && filteredBranchEntries.length === 0"
      class="source-control-info-note source-control-branches-note">
      正在读取 Git 分支…
    </div>

    <template v-else-if="filteredBranchEntries.length > 0">
      <section v-for="group in branchGroups" :key="group.key" class="source-control-branch-group">
        <div class="source-control-branch-group-header">
          <span> group.title </span>
          <span class="source-control-branch-group-count"> group.entries.length </span>
        </div>

        <div class="source-control-branch-list">
          <article v-for="entry in group.entries" :key="entry.name" class="source-control-branch-row"
            :class="{ 'is-current': entry.isCurrent }" :role="entry.isCurrent ? undefined : 'button'"
            :tabindex="entry.isCurrent ? undefined : 0"
            :aria-current="entry.isCurrent ? 'true' : undefined" @click="handleCheckoutBranch(entry)"
            @keydown.enter.prevent="handleCheckoutBranch(entry)">
            <svg class="source-control-branch-row-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="6" cy="6" r="2" />
              <circle cx="18" cy="4" r="2" />
              <circle cx="18" cy="18" r="2" />
              <path d="M8 6h4a4 4 0 0 1 4 4v6" />
              <path d="M16 6v2" />
            </svg>

            <div class="source-control-branch-row-body">
              <span class="source-control-branch-row-name"> entry.shorthand </span>
              <span v-if="resolveBranchMeta(entry)" class="source-control-branch-row-meta"> resolveBranchMeta(entry) </span>
            </div>

            <span v-if="entry.isCurrent" class="source-control-branch-row-current">当前</span>
            <span v-else aria-hidden="true" class="source-control-branch-row-switch">切换</span>
          </article>
        </div>
      </section>
    </template>

    <p v-else class="source-control-info-note source-control-branches-note"> branchesEmptyText </p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useMessage } from '@/composables/useMessage';
import { useGitStore } from '@/store/git';
import type { IGitBranchPayload } from '@/types/git';
import { toErrorMessage } from '@/utils/error';

const props = defineProps<{
  searchQuery: string;
  isBusy: boolean;
  runWithPending: (key: string, task: () => Promise<void>) => Promise<boolean>;
}>();

const gitStore = useGitStore();
const message = useMessage();

const status = computed(() => gitStore.status);
const branchEntries = computed<IGitBranchPayload[]>(() => gitStore.branches);
const isBranchesLoading = computed(() => gitStore.isBranchesLoading);

const isBranchCreateOpen = ref(false);
const branchCreateName = ref('');
const branchCreateError = ref<string | null>(null);
const branchNameInputRef = ref<HTMLInputElement | null>(null);

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

const filteredBranchEntries = computed(() =>
  branchEntries.value.filter((entry) =>
    matchesSearchQuery([entry.shorthand, entry.upstreamName, entry.lastCommit?.summary ?? null]),
  ),
);

const branchesPanelSummary = computed(() => {
  if (props.searchQuery.trim()) {
    return `匹配 ${filteredBranchEntries.value.length} 个`;
  }

  const total = branchEntries.value.length;
  if (total === 0) {
    return isBranchesLoading.value ? '正在同步' : '暂无分支';
  }

  return `共 ${total} 个`;
});

const branchGroups = computed<
  Array<{ key: 'local' | 'remote'; title: string; entries: IGitBranchPayload[] }>
>(() => {
  const localEntries = filteredBranchEntries.value.filter((entry) => entry.kind !== 'remote');
  const remoteEntries = filteredBranchEntries.value.filter((entry) => entry.kind === 'remote');

  const groups: Array<{ key: 'local' | 'remote'; title: string; entries: IGitBranchPayload[] }> =
    [];
  if (localEntries.length > 0) {
    groups.push({ key: 'local', title: '本地', entries: localEntries });
  }
  if (remoteEntries.length > 0) {
    groups.push({ key: 'remote', title: '远程', entries: remoteEntries });
  }

  return groups;
});

const branchesEmptyText = computed(() =>
  props.searchQuery.trim() ? '没有匹配的分支。' : '当前仓库没有可显示的分支。',
);

const resolveBranchMeta = (entry: IGitBranchPayload): string => {
  const segments: string[] = [];
  if (entry.upstreamName) {
    segments.push(entry.upstreamName);
  }
  if (entry.lastCommit) {
    segments.push(entry.lastCommit.shortId);
  }

  return segments.join(' · ');
};

const handleReloadBranches = async (): Promise<void> => {
  try {
    await gitStore.loadBranches();
  } catch (error) {
    message.error(toErrorMessage(error, '读取 Git 分支失败'));
  }
};

const INVALID_BRANCH_CHARS = [' ', '~', '^', ':', '?', '*', '[', ']'];

const validateBranchName = (rawName: string): string | null => {
  const name = rawName.trim();
  if (!name) {
    return '分支名称不能为空。';
  }
  if (INVALID_BRANCH_CHARS.some((char) => name.includes(char))) {
    return '分支名称包含非法字符（空格、~、^、:、?、*、[、] 等）。';
  }
  if (name.includes('..')) {
    return '分支名称不能包含连续的点（..）。';
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return '分支名称不能以点（.）开头或结尾。';
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    return '分支名称不能以斜杠（/）开头或结尾。';
  }
  const exists = branchEntries.value.some(
    (entry) => entry.kind !== 'remote' && entry.shorthand === name,
  );
  if (exists) {
    return '已存在同名本地分支。';
  }

  return null;
};

const openBranchCreate = (): void => {
  if (props.isBusy) {
    return;
  }

  isBranchCreateOpen.value = true;
  branchCreateName.value = '';
  branchCreateError.value = null;
  void nextTick(() => {
    branchNameInputRef.value?.focus();
  });
};

const cancelBranchCreate = (): void => {
  isBranchCreateOpen.value = false;
  branchCreateName.value = '';
  branchCreateError.value = null;
};

const submitBranchCreate = async (): Promise<void> => {
  const branchName = branchCreateName.value.trim();
  const validationError = validateBranchName(branchName);
  if (validationError) {
    branchCreateError.value = validationError;
    return;
  }

  try {
    const didRun = await props.runWithPending('create-branch', async () => {
      await gitStore.createBranch(branchName, true);
      await gitStore.loadBranches();
    });

    if (!didRun) {
      return;
    }

    cancelBranchCreate();
    message.success(`已创建并切换到 ${branchName}`);
  } catch (error) {
    branchCreateError.value = toErrorMessage(error, '创建 Git 分支失败');
  }
};

const handleCheckoutBranch = async (entry: IGitBranchPayload): Promise<void> => {
  if (entry.isCurrent) {
    return;
  }

  try {
    const didRun = await props.runWithPending(`checkout-branch:${entry.name}`, async () => {
      await gitStore.checkoutBranch(entry.shorthand);
      await gitStore.loadBranches();
    });

    if (!didRun) {
      return;
    }

    message.success(`已切换到 ${entry.shorthand}`);
  } catch (error) {
    message.error(toErrorMessage(error, '切换 Git 分支失败'));
  }
};
</script>
