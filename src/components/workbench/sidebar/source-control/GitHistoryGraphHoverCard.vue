<script setup lang="ts">
import { Check, Copy, UserRound } from '@lucide/vue';
import { computed, onBeforeUnmount, ref } from 'vue';
import Github from '@/components/ui/icon/GithubIcon.vue';
import type { IGitHubCommitAuthorSnapshot } from '@/services/github-author';
import type { IGitCommitDetailPayload, IGitCommitSummaryPayload } from '@/types/git';

const props = defineProps<{
  visible: boolean;
  commit: IGitCommitSummaryPayload | null;
  detail: IGitCommitDetailPayload | null;
  loading: boolean;
  authorSnapshot: IGitHubCommitAuthorSnapshot | null;
  x: number;
  y: number;
  githubUrl: string | null;
}>();

const emit = defineEmits<{
  'copy-sha': [];
  'open-github': [];
  'card-enter': [];
  'card-leave': [];
}>();

const rootEl = ref<HTMLElement | null>(null);
defineExpose({ getRootEl: (): HTMLElement | null => rootEl.value });

// 复制提交哈希成功后短暂显示对勾，1.6s 后自动恢复复制图标。
const commitIdCopied = ref(false);
let commitIdCopiedTimer: ReturnType<typeof setTimeout> | null = null;

const handleCopyClick = (): void => {
  emit('copy-sha');
  commitIdCopied.value = true;
  if (commitIdCopiedTimer !== null) clearTimeout(commitIdCopiedTimer);
  commitIdCopiedTimer = setTimeout(() => {
    commitIdCopied.value = false;
    commitIdCopiedTimer = null;
  }, 1600);
};

const authorName = computed<string>(
  () => props.detail?.authorName ?? props.commit?.authorName ?? '',
);
const authorDisplayName = computed<string>(
  () => props.authorSnapshot?.login ?? props.authorSnapshot?.name ?? authorName.value,
);
const authorAvatarUrl = computed<string | null>(() => props.authorSnapshot?.avatarUrl ?? null);
const authoredAt = computed<string>(
  () => props.detail?.authoredAt ?? props.commit?.authoredAt ?? '',
);
const shortId = computed<string>(() => props.detail?.shortId ?? props.commit?.shortId ?? '');
const message = computed<string>(() => {
  const detail = props.detail;
  if (detail) return detail.body ? `${detail.summary}\n\n${detail.body}` : detail.summary;
  return props.commit?.summary ?? '';
});

const formatTime = (value: string | null | undefined): string => {
  if (!value) return '';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '';
  const diff = Math.max(0, Date.now() - time);
  if (diff < 30000) return '刚刚';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(value).toLocaleDateString();
};

const formatAbsolute = (value: string | null | undefined): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hours}:${minutes}`;
};

onBeforeUnmount(() => {
  if (commitIdCopiedTimer !== null) {
    clearTimeout(commitIdCopiedTimer);
    commitIdCopiedTimer = null;
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && commit"
      ref="rootEl"
      class="git-history-graph-hovercard"
      :style="{ top: y + 'px', left: x + 'px' }"
      @mouseenter="emit('card-enter')"
      @mouseleave="emit('card-leave')"
    >
      <div class="git-history-graph-hovercard-head">
        <div class="git-history-graph-hovercard-identity">
          <img
            v-if="authorAvatarUrl"
            class="git-history-graph-hovercard-avatar"
            :src="authorAvatarUrl"
            alt=""
            referrerpolicy="no-referrer"
          />
          <span v-else class="git-history-graph-hovercard-avatar is-placeholder" aria-hidden="true">
            <UserRound />
          </span>
          <div class="git-history-graph-hovercard-author-block">
            <span class="git-history-graph-hovercard-author" v-text="authorDisplayName" />
            <span
              v-if="formatAbsolute(authoredAt)"
              class="git-history-graph-hovercard-date"
              v-text="formatAbsolute(authoredAt)"
            />
          </div>
        </div>
        <span class="git-history-graph-hovercard-ago" v-text="formatTime(authoredAt)" />
      </div>

      <p class="git-history-graph-hovercard-message" v-text="message" />
      <div class="git-history-graph-hovercard-stats">
        <span
          v-if="loading && !detail"
          class="git-history-graph-hovercard-loading"
          v-text="'正在统计变更…'"
        />
        <template v-else-if="detail">
          <span class="git-history-graph-hovercard-files" v-text="'已更改 ' + detail.fileCount + ' 个文件'" />
          <span v-if="detail.additions > 0" class="git-history-graph-hovercard-add" v-text="'+' + detail.additions" />
          <span v-if="detail.deletions > 0" class="git-history-graph-hovercard-del" v-text="'-' + detail.deletions" />
        </template>
      </div>
      <div class="git-history-graph-hovercard-foot">
        <code class="git-history-graph-hovercard-sha" v-text="shortId" />
        <div class="git-history-graph-hovercard-actions">
          <button
            type="button"
            class="git-history-graph-hovercard-action"
            :class="{ 'is-copied': commitIdCopied }"
            title="复制完整提交哈希"
            aria-label="复制完整提交哈希"
            @click="handleCopyClick"
          >
            <Check v-if="commitIdCopied" aria-hidden="true" />
            <Copy v-else aria-hidden="true" />
          </button>
          <button
            v-if="githubUrl"
            type="button"
            class="git-history-graph-hovercard-open"
            @click="emit('open-github')"
          >
            <Github aria-hidden="true" />
            <span>在 GitHub 上打开</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.git-history-graph-hovercard {
  position: fixed;
  z-index: 9999;
  width: 340px;
  background: #ffffff;
  border: 1px solid #d1d9e0;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(31, 35, 40, 0.12);
  padding: 12px 14px 10px;
  pointer-events: auto;
}

.git-history-graph-hovercard-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.git-history-graph-hovercard-identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.git-history-graph-hovercard-avatar {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(129, 139, 152, 0.12);
  color: #818b98;
  object-fit: cover;
}

.git-history-graph-hovercard-avatar.is-placeholder > span {
  width: 16px;
  height: 16px;
}

.git-history-graph-hovercard-author-block {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.git-history-graph-hovercard-author {
  font-size: 12px;
  font-weight: 600;
  color: #1f2328;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-history-graph-hovercard-ago,
.git-history-graph-hovercard-date {
  font-size: 11px;
  color: #818b98;
  white-space: nowrap;
}

.git-history-graph-hovercard-ago {
  flex-shrink: 0;
  padding-top: 1px;
}

.git-history-graph-hovercard-message {
  font-size: 12px;
  color: #1f2328;
  margin: 0 0 10px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}

.git-history-graph-hovercard-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}

.git-history-graph-hovercard-loading { color: #818b98; }
.git-history-graph-hovercard-files { color: #59636e; }
.git-history-graph-hovercard-add { color: #1a7f37; font-weight: 600; }
.git-history-graph-hovercard-del { color: #cf222e; font-weight: 600; }

.git-history-graph-hovercard-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid #d1d9e0;
  padding-top: 8px;
}

.git-history-graph-hovercard-sha {
  font-family: ui-monospace, 'SFMono-Regular', monospace;
  font-size: 11px;
  color: #818b98;
  background: rgba(129, 139, 152, 0.1);
  padding: 1px 5px;
  border-radius: 4px;
}

.git-history-graph-hovercard-actions {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.git-history-graph-hovercard-action,
.git-history-graph-hovercard-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: #818b98;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  padding: 0;
}

.git-history-graph-hovercard-action {
  width: 22px;
  height: 22px;
  border-radius: 4px;
}

.git-history-graph-hovercard-open {
  gap: 5px;
  min-height: 24px;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 11.5px;
  font-weight: 500;
  color: #0969da;
}

.git-history-graph-hovercard-action:hover,
.git-history-graph-hovercard-open:hover {
  background: rgba(129, 139, 152, 0.15);
  color: #1f2328;
}

/* 复制成功后的对勾用绿色强调，1.6s 后恢复 */
.git-history-graph-hovercard-action.is-copied,
.git-history-graph-hovercard-action.is-copied:hover {
  color: #1a7f37;
}

.git-history-graph-hovercard-open > span:first-child {
  width: 13px;
  height: 13px;
}
</style>
