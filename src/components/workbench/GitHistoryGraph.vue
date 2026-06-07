<template>
  <div ref="rootRef" class="git-history-graph source-control-history-timeline">
    <template v-for="group in renderGroups" :key="group.key">
      <header
        v-if="group.showHeader"
        class="git-history-graph-group-header"
        :class="'git-history-graph-group-' + group.tone"
      >
        <span :class="group.icon" class="git-history-graph-group-icon" aria-hidden="true" />
        <span class="git-history-graph-group-title" v-text="group.title" />
        <span class="git-history-graph-group-count" v-text="group.count" />
      </header>

      <template v-for="row in group.rows" :key="row.commit.id">
        <article
          class="source-control-history-item git-history-graph-row"
          :class="{ 'is-active': row.commit.id === activeCommitId, 'is-expanded': row.commit.id === expandedCommitId }"
          @click="handleSelect(row.commit)"
          @contextmenu="handleContextMenu($event, row.commit)"
          @mouseenter="handleRowEnter($event, row.commit)"
          @mouseleave="handleRowLeave"
        >
          <div class="git-history-graph-cell" :style="{ width: graphWidth + 'px' }" aria-hidden="true">
            <svg
              class="git-history-graph-svg"
              :width="graphWidth"
              :height="ROW_HEIGHT"
              :viewBox="'0 0 ' + graphWidth + ' ' + ROW_HEIGHT"
            >
              <path
                v-for="edge in row.paths"
                :key="edge.key"
                :d="edge.d"
                :stroke="edge.color"
                class="git-history-graph-edge"
                fill="none"
              />
              <circle
                :cx="row.nodeX"
                :cy="ROW_HEIGHT / 2"
                :r="NODE_RADIUS"
                :fill="row.nodeColor"
                class="git-history-graph-node"
              />
            </svg>
          </div>

          <div class="git-history-graph-body">
            <span class="git-history-graph-message-text" v-text="row.commit.summary" />
            <span
              v-for="commitRef in row.refs"
              :key="commitRef.name"
              class="git-history-graph-ref"
              :class="refClass(commitRef)"
            >
              <span :class="refIcon(commitRef)" class="git-history-graph-ref-icon" aria-hidden="true" />
              <span class="git-history-graph-ref-name" v-text="commitRef.name" />
            </span>
          </div>
        </article>

        <!-- Inline expanded file list -->
        <div
          v-if="row.commit.id === expandedCommitId"
          class="git-history-graph-filelist"
        >
          <div v-if="expandedLoading && !expandedDetail" class="git-history-graph-filelist-loading">
            <span class="icon-[lucide--loader-circle] git-history-graph-filelist-spinner" aria-hidden="true" />
            <span v-text="'正在读取文件列表…'" />
          </div>
          <template v-else-if="expandedDetail && expandedDetail.files.length > 0">
            <div
              v-for="file in expandedDetail.files"
              :key="file.relativePath"
              class="git-history-graph-filelist-item"
            >
              <div
                class="git-history-graph-filelist-row"
                role="button"
                tabindex="0"
                @click="handleFileClick(file)"
              >
                <span class="git-history-graph-filelist-icon" :class="'is-' + file.status" aria-hidden="true">
                  <span :class="resolveFileIcon(file.status)" />
                </span>
                <span class="git-history-graph-filelist-name" v-text="file.fileName" />
                <span v-if="file.previousRelativePath" class="git-history-graph-filelist-renamed" v-text="'← ' + file.previousRelativePath" />
                <span class="git-history-graph-filelist-path" v-text="resolveFileDir(file)" />
                <span v-if="file.additions > 0" class="git-history-graph-filelist-stat git-history-graph-filelist-stat-add" v-text="'+' + file.additions" />
                <span v-if="file.deletions > 0" class="git-history-graph-filelist-stat git-history-graph-filelist-stat-del" v-text="'-' + file.deletions" />
              </div>
            </div>
          </template>
          <div v-else-if="expandedDetail" class="git-history-graph-filelist-empty">
            <span v-text="'该提交没有文件变更'" />
          </div>
        </div>
      </template>
    </template>

    <div
      v-if="gitStore.canLoadMoreCommitHistory"
      ref="historySentinelRef"
      class="git-history-graph-sentinel"
      aria-hidden="true"
    />

    <section v-if="behind > 0" class="git-history-graph-incoming-note">
      <span class="icon-[lucide--arrow-down] git-history-graph-group-icon" aria-hidden="true" />
      <span v-text="'传入更改 ' + behind + ' 条 · 拉取后查看'" />
    </section>

    <LinearContextMenu
      :open="menu.open"
      :x="menu.x"
      :y="menu.y"
      :groups="menuGroups"
      theme="light"
      submenu-direction="right"
      @select="handleMenuSelect"
    />

    <Teleport to="body">
      <div
        v-if="hover.open && hoverCommit"
        ref="hoverCardRef"
        class="git-history-graph-hovercard"
        :style="{ top: hover.y + 'px', left: hover.x + 'px' }"
        @mouseenter="handleCardEnter"
        @mouseleave="handleCardLeave"
      >
        <div class="git-history-graph-hovercard-head">
          <div class="git-history-graph-hovercard-identity">
            <img
              v-if="hoverAuthorAvatarUrl"
              class="git-history-graph-hovercard-avatar"
              :src="hoverAuthorAvatarUrl"
              alt=""
              referrerpolicy="no-referrer"
            />
            <span v-else class="git-history-graph-hovercard-avatar is-placeholder" aria-hidden="true">
              <span class="icon-[lucide--user-round]" />
            </span>
            <div class="git-history-graph-hovercard-author-block">
              <span class="git-history-graph-hovercard-author" v-text="hoverAuthorDisplayName" />
              <span
                v-if="formatAbsolute(hoverAuthoredAt)"
                class="git-history-graph-hovercard-date"
                v-text="formatAbsolute(hoverAuthoredAt)"
              />
            </div>
          </div>
          <span class="git-history-graph-hovercard-ago" v-text="formatTime(hoverAuthoredAt)" />
        </div>

        <p class="git-history-graph-hovercard-message" v-text="hoverMessage" />
        <div class="git-history-graph-hovercard-stats">
          <span
            v-if="hoverLoading && !hoverDetail"
            class="git-history-graph-hovercard-loading"
            v-text="'正在统计变更…'"
          />
          <template v-else-if="hoverDetail">
            <span class="git-history-graph-hovercard-files" v-text="'已更改 ' + hoverDetail.fileCount + ' 个文件'" />
            <span v-if="hoverDetail.additions > 0" class="git-history-graph-hovercard-add" v-text="'+' + hoverDetail.additions" />
            <span v-if="hoverDetail.deletions > 0" class="git-history-graph-hovercard-del" v-text="'-' + hoverDetail.deletions" />
          </template>
        </div>
        <div class="git-history-graph-hovercard-foot">
          <code class="git-history-graph-hovercard-sha" v-text="hoverShortId" />
          <div class="git-history-graph-hovercard-actions">
            <button
              type="button"
              class="git-history-graph-hovercard-action"
              title="复制完整提交哈希"
              aria-label="复制完整提交哈希"
              @click="copyHoverCommitId"
            >
              <span class="icon-[lucide--copy]" aria-hidden="true" />
            </button>
            <button
              v-if="hoverGithubCommitUrl"
              type="button"
              class="git-history-graph-hovercard-open"
              @click="openHoverCommitOnGithub"
            >
              <span class="icon-[lucide--github]" aria-hidden="true" />
              <span>在 GitHub 上打开</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import { useEditorStore } from '@/store/editor';
import { useGitStore } from '@/store/git';
import type {
  IGitCommitDetailPayload,
  IGitCommitFileChangePayload,
  IGitCommitSummaryPayload,
} from '@/types/git';
import { openExternalUrl } from '@/utils/browser';
import { writeClipboardText } from '@/utils/clipboard';
import type { IGitGraphEdge } from '@/utils/git-graph';
import { buildGitGraph, resolveGitGraphLaneColor } from '@/utils/git-graph';

const LANE_WIDTH = 13;
const ROW_HEIGHT = 28;
const NODE_RADIUS = 3;
const HOVER_OPEN_DELAY = 320;
const HOVER_CLOSE_DELAY = 160;
const HOVER_CARD_WIDTH = 340;
// 悬浮卡片高度估算值,仅用于首帧定位;真实尺寸由 adjustHoverCardPosition 实测后再夹取。
const HOVER_CARD_EST_HEIGHT = 210;
const GITHUB_AUTHOR_CACHE_PREFIX = 'calamex.githubAuthor.';
const GITHUB_AUTHOR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface IGitCommitRef {
  name: string;
  kind: string;
  isHead: boolean;
}
interface IGraphEdgePath {
  key: string;
  d: string;
  color: string;
}
interface IGraphRow {
  commit: IGitCommitSummaryPayload;
  nodeX: number;
  nodeColor: string;
  refs: IGitCommitRef[];
  paths: IGraphEdgePath[];
}
interface IGraphGroup {
  key: string;
  title: string;
  icon: string;
  tone: string;
  count: number;
  showHeader: boolean;
  rows: IGraphRow[];
}
interface IGitHubCommitAuthorSnapshot {
  login: string | null;
  name: string;
  avatarUrl: string | null;
  htmlUrl: string | null;
  updatedAt: number;
}

const props = withDefaults(
  defineProps<{ commits: IGitCommitSummaryPayload[]; ahead?: number; behind?: number }>(),
  { ahead: 0, behind: 0 },
);

const emit = defineEmits<{ 'select-commit': [commit: IGitCommitSummaryPayload] }>();

const gitStore = useGitStore();
const editorStore = useEditorStore();
const activeCommitId = ref<string | null>(null);
const expandedCommitId = ref<string | null>(null);
const expandedDetail = ref<IGitCommitDetailPayload | null>(null);
const expandedLoading = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const pendingGithubAuthorRequests = new Map<string, Promise<IGitHubCommitAuthorSnapshot | null>>();

const menu = reactive<{
  open: boolean;
  x: number;
  y: number;
  commit: IGitCommitSummaryPayload | null;
}>({
  open: false,
  x: 0,
  y: 0,
  commit: null,
});

const hover = reactive<{ open: boolean; commitId: string | null; x: number; y: number }>({
  open: false,
  commitId: null,
  x: 0,
  y: 0,
});

const hoverCommit = ref<IGitCommitSummaryPayload | null>(null);
const hoverDetail = ref<IGitCommitDetailPayload | null>(null);
const hoverLoading = ref(false);
const hoverAuthorSnapshot = ref<IGitHubCommitAuthorSnapshot | null>(null);
const hoverCardRef = ref<HTMLElement | null>(null);
let hoverOpenTimer: ReturnType<typeof setTimeout> | null = null;
let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null;

// 滚动期间抑制悬浮卡片,避免滑动时小卡片打扰。
const isScrolling = ref(false);
let scrollSettleTimer: ReturnType<typeof setTimeout> | null = null;
let historyScrollTarget: HTMLElement | Window | null = null;
let historyScrollCapture = false;

const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2;

const buildEdgePath = (edge: IGitGraphEdge, rowHeight: number): string => {
  const x1 = laneX(edge.fromLane);
  const x2 = laneX(edge.toLane);
  const mid = rowHeight / 2;
  if (edge.type === 'pass' && edge.fromLane === edge.toLane)
    return `M ${x1} 0 L ${x1} ${rowHeight}`;
  if (edge.type === 'in') return `M ${x1} 0 C ${x1} ${mid * 0.6} ${x2} ${mid * 0.4} ${x2} ${mid}`;
  if (edge.type === 'out')
    return (
      'M ' +
      x1 +
      ' ' +
      mid +
      ' C ' +
      x1 +
      ' ' +
      (mid + mid * 0.4) +
      ' ' +
      x2 +
      ' ' +
      (mid + mid * 0.6) +
      ' ' +
      x2 +
      ' ' +
      rowHeight
    );
  return `M ${x1} 0 C ${x1} ${mid} ${x2} ${mid} ${x2} ${rowHeight}`;
};

const layout = computed(() =>
  buildGitGraph(
    props.commits.map((commit) => ({ id: commit.id, parentIds: commit.parentIds ?? [] })),
  ),
);

const graphWidth = computed(() => Math.max(1, layout.value.laneCount) * LANE_WIDTH);

const decorated = computed<IGraphRow[]>(() =>
  props.commits.map((commit, index) => {
    const row = layout.value.rows[index];
    const lane = row ? row.lane : 0;
    const nodeColor = row ? row.color : resolveGitGraphLaneColor(0);
    const edges = row ? row.edges : [];
    return {
      commit,
      nodeX: laneX(lane),
      nodeColor,
      refs: (commit.refs ?? []) as IGitCommitRef[],
      paths: edges.map((edge, edgeIndex) => ({
        key: `${edge.type}:${edge.fromLane}:${edge.toLane}:${edgeIndex}`,
        d: buildEdgePath(edge, ROW_HEIGHT),
        color: edge.color,
      })),
    };
  }),
);

const outgoingRows = computed<IGraphRow[]>(() =>
  decorated.value.slice(0, Math.max(0, props.ahead)),
);
const historyRows = computed<IGraphRow[]>(() => decorated.value.slice(Math.max(0, props.ahead)));

const renderGroups = computed<IGraphGroup[]>(() => {
  const groups: IGraphGroup[] = [];
  if (outgoingRows.value.length > 0) {
    groups.push({
      key: 'outgoing',
      title: '传出更改',
      icon: 'icon-[lucide--arrow-up]',
      tone: 'outgoing',
      count: outgoingRows.value.length,
      showHeader: true,
      rows: outgoingRows.value,
    });
  }
  groups.push({
    key: 'history',
    title: '历史',
    icon: 'icon-[lucide--git-commit-horizontal]',
    tone: 'history',
    count: historyRows.value.length,
    showHeader: outgoingRows.value.length > 0,
    rows: historyRows.value,
  });
  return groups;
});

const hoverGithubCommitUrl = computed<string | null>(() => {
  const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
  const commitId = hoverDetail.value?.id ?? hoverCommit.value?.id;
  return repoUrl && commitId ? `${repoUrl}/commit/${commitId}` : null;
});
const hoverMessage = computed<string>(() => {
  const detail = hoverDetail.value;
  if (detail) return detail.body ? `${detail.summary}\n\n${detail.body}` : detail.summary;
  return hoverCommit.value?.summary ?? '';
});
const hoverAuthorName = computed<string>(
  () => hoverDetail.value?.authorName ?? hoverCommit.value?.authorName ?? '',
);
const hoverAuthorDisplayName = computed<string>(
  () => hoverAuthorSnapshot.value?.login ?? hoverAuthorSnapshot.value?.name ?? hoverAuthorName.value,
);
const hoverAuthorAvatarUrl = computed<string | null>(() => hoverAuthorSnapshot.value?.avatarUrl ?? null);
const hoverAuthoredAt = computed<string>(
  () => hoverDetail.value?.authoredAt ?? hoverCommit.value?.authoredAt ?? '',
);
const hoverShortId = computed<string>(
  () => hoverDetail.value?.shortId ?? hoverCommit.value?.shortId ?? '',
);

const menuGroups = computed<ILinearContextMenuGroup[]>(() => {
  if (!menu.commit) return [];
  const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
  return [
    {
      key: 'copy',
      items: [
        { key: 'copy-sha', label: '复制提交哈希', icon: 'copy' },
        { key: 'copy-short', label: '复制短哈希', icon: 'copy' },
        { key: 'copy-message', label: '复制提交说明', icon: 'copy' },
      ],
    },
    {
      key: 'actions',
      items: [
        { key: 'checkout-commit', label: '检出此提交', icon: 'git-branch' },
        { key: 'revert-commit', label: '回滚此提交', icon: 'rotate-ccw' },
        ...(repoUrl
          ? [
              {
                key: 'open-github',
                label: '在 GitHub 上打开',
                icon: 'external-link',
              } as ILinearContextMenuItem,
            ]
          : []),
      ],
    },
  ];
});

const refClass = (commitRef: IGitCommitRef): Record<string, boolean> => ({
  'is-head': commitRef.isHead,
  'is-remote': commitRef.kind === 'remoteBranch',
  'is-local': commitRef.kind === 'localBranch' && !commitRef.isHead,
});

const refIcon = (commitRef: IGitCommitRef): string =>
  commitRef.kind === 'remoteBranch' ? 'icon-[lucide--cloud]' : 'icon-[lucide--git-branch]';

const resolveFileIcon = (status: string): string => {
  switch (status) {
    case 'added':
      return 'icon-[lucide--file-plus]';
    case 'deleted':
      return 'icon-[lucide--file-minus]';
    case 'renamed':
      return 'icon-[lucide--file-symlink]';
    case 'binary':
      return 'icon-[lucide--file-digit]';
    default:
      return 'icon-[lucide--file-pen-line]';
  }
};

const resolveFileDir = (file: IGitCommitFileChangePayload): string => {
  const path = file.relativePath;
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash) : '';
};

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

const resolveLocalStorage = (): Storage | null => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
};

const resolveGithubHost = (repoUrl: string): string | null => {
  try {
    return new URL(repoUrl).host.toLowerCase();
  } catch {
    const match = repoUrl.match(/^https:\/\/([^/]+)/);
    return match?.[1]?.toLowerCase() ?? null;
  }
};

const resolveGithubAuthorIdentity = (commit: IGitCommitSummaryPayload): string | null => {
  const email = commit.authorEmail?.trim().toLowerCase();
  if (email) return `email:${email}`;

  const name = commit.authorName?.trim().toLowerCase();
  return name ? `name:${name}` : null;
};

const resolveGithubAuthorCacheKey = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): string | null => {
  const host = resolveGithubHost(repoUrl);
  const identity = resolveGithubAuthorIdentity(commit);
  if (!host || !identity) return null;
  return `${GITHUB_AUTHOR_CACHE_PREFIX}${encodeURIComponent(host)}:${encodeURIComponent(identity)}`;
};

const readCachedGithubAuthor = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): IGitHubCommitAuthorSnapshot | null => {
  const storage = resolveLocalStorage();
  const cacheKey = resolveGithubAuthorCacheKey(repoUrl, commit);
  if (!storage || !cacheKey) return null;
  try {
    const raw = storage.getItem(cacheKey);
    if (!raw) return null;
    const cached = JSON.parse(raw) as IGitHubCommitAuthorSnapshot;
    if (!cached || typeof cached.updatedAt !== 'number') return null;
    if (Date.now() - cached.updatedAt > GITHUB_AUTHOR_CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
};

const writeCachedGithubAuthor = (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
  snapshot: IGitHubCommitAuthorSnapshot,
): void => {
  const storage = resolveLocalStorage();
  const cacheKey = resolveGithubAuthorCacheKey(repoUrl, commit);
  if (!storage || !cacheKey) return;
  try {
    storage.setItem(cacheKey, JSON.stringify(snapshot));
  } catch {
    // Avatar cache is best-effort only.
  }
};

const resolveGithubCommitApiUrl = (repoUrl: string, commitId: string): string | null => {
  const match = repoUrl.match(/^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;

  const [, host, owner, repo] = match;
  const cleanRepo = repo.replace(/\.git$/, '');
  const apiBase = host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://api.${host}`;
  return `${apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(cleanRepo)}/commits/${commitId}`;
};

const fetchGithubAuthorSnapshot = async (
  repoUrl: string,
  commit: IGitCommitSummaryPayload,
): Promise<IGitHubCommitAuthorSnapshot | null> => {
  const apiUrl = resolveGithubCommitApiUrl(repoUrl, commit.id);
  const cacheKey = resolveGithubAuthorCacheKey(repoUrl, commit);
  if (!apiUrl || !cacheKey) return null;

  const pending = pendingGithubAuthorRequests.get(cacheKey);
  if (pending) return pending;

  const request = fetch(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
    },
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const value = (await response.json()) as {
        author?: { login?: string | null; avatar_url?: string | null; html_url?: string | null } | null;
        commit?: { author?: { name?: string | null } | null } | null;
      };
      const snapshot: IGitHubCommitAuthorSnapshot = {
        login: value.author?.login ?? null,
        name: value.commit?.author?.name ?? commit.authorName,
        avatarUrl: value.author?.avatar_url ?? null,
        htmlUrl: value.author?.html_url ?? null,
        updatedAt: Date.now(),
      };
      writeCachedGithubAuthor(repoUrl, commit, snapshot);
      return snapshot;
    })
    .catch(() => null)
    .finally(() => {
      pendingGithubAuthorRequests.delete(cacheKey);
    });

  pendingGithubAuthorRequests.set(cacheKey, request);
  return request;
};

const hydrateHoverGithubAuthor = async (commit: IGitCommitSummaryPayload): Promise<void> => {
  let repoUrl = gitStore.pullRequestSupport.repositoryUrl;
  if (!repoUrl) {
    try {
      repoUrl = (await gitStore.loadPullRequestSupport()).repositoryUrl;
    } catch {
      repoUrl = null;
    }
  }
  if (!repoUrl) return;

  const cached = readCachedGithubAuthor(repoUrl, commit);
  if (cached) {
    if (hover.commitId === commit.id) hoverAuthorSnapshot.value = cached;
    return;
  }

  const snapshot = await fetchGithubAuthorSnapshot(repoUrl, commit);
  if (snapshot && hover.commitId === commit.id) {
    hoverAuthorSnapshot.value = snapshot;
    void adjustHoverCardPosition();
  }
};

const loadExpandedDetail = async (commit: IGitCommitSummaryPayload): Promise<void> => {
  expandedDetail.value = null;
  expandedLoading.value = true;
  try {
    const detail = await gitStore.loadCommitDetail(commit.id);
    if (expandedCommitId.value === commit.id) {
      expandedDetail.value = detail;
    }
  } catch {
    // ignore errors
  } finally {
    if (expandedCommitId.value === commit.id) {
      expandedLoading.value = false;
    }
  }
};

const handleSelect = (commit: IGitCommitSummaryPayload): void => {
  // toggle expansion
  if (expandedCommitId.value === commit.id) {
    expandedCommitId.value = null;
    expandedDetail.value = null;
    expandedLoading.value = false;
    return;
  }
  activeCommitId.value = commit.id;
  expandedCommitId.value = commit.id;
  emit('select-commit', commit);
  void loadExpandedDetail(commit);
};

// 点击具体文件：复用主界面原有的只读 Diff 视图（与右键菜单“查看 Diff”一致），
// 打开该提交对比父提交的文件 Diff。
const handleFileClick = async (file: IGitCommitFileChangePayload): Promise<void> => {
  const commitId = expandedCommitId.value;
  if (!commitId) return;
  try {
    const preview = await gitStore.loadCommitFileDiffPreview(commitId, file.relativePath);
    editorStore.openGitDiffDocument(preview);
  } catch (error) {
    console.error('[GitHistoryGraph] open commit file diff failed:', error);
  }
};

const clearHoverOpenTimer = (): void => {
  if (hoverOpenTimer !== null) {
    clearTimeout(hoverOpenTimer);
    hoverOpenTimer = null;
  }
};

const clearHoverCloseTimer = (): void => {
  if (hoverCloseTimer !== null) {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }
};

const closeHoverCard = (): void => {
  hover.open = false;
  hover.commitId = null;
  hoverCommit.value = null;
  hoverDetail.value = null;
  hoverAuthorSnapshot.value = null;
  hoverLoading.value = false;
};

// req4: 悬浮卡片智能排位。先按行右/左侧给初始位置,再用实测尺寸夹取进视口,避免被边缘遮挡。
const positionHoverCard = (rect: DOMRect): { x: number; y: number } => {
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // 横向：优先放在行右侧,空间不足则放左侧,再不足则夹在视口内。
  let x = rect.right + margin;
  if (x + HOVER_CARD_WIDTH > vw - margin) {
    const leftX = rect.left - HOVER_CARD_WIDTH - margin;
    x = leftX >= margin ? leftX : Math.max(margin, vw - HOVER_CARD_WIDTH - margin);
  }
  if (x < margin) x = margin;
  // 纵向：默认与行顶对齐;底部空间不足时上移,保证整卡在视口内。
  let y = rect.top;
  if (y + HOVER_CARD_EST_HEIGHT > vh - margin) y = vh - HOVER_CARD_EST_HEIGHT - margin;
  if (y < margin) y = margin;
  return { x, y };
};

// 卡片渲染/详情加载导致高度变化后,按真实尺寸再次夹取,确保不被视口边缘截断。
const adjustHoverCardPosition = async (): Promise<void> => {
  if (typeof window === 'undefined') return;
  await nextTick();
  const el = hoverCardRef.value;
  if (!el || !hover.open) return;
  const margin = 8;
  const rect = el.getBoundingClientRect();
  let x = hover.x;
  let y = hover.y;
  if (rect.right > window.innerWidth - margin) x = window.innerWidth - rect.width - margin;
  if (x < margin) x = margin;
  if (rect.bottom > window.innerHeight - margin) y = window.innerHeight - rect.height - margin;
  if (y < margin) y = margin;
  hover.x = x;
  hover.y = y;
};

const openHoverCard = async (rect: DOMRect, commit: IGitCommitSummaryPayload): Promise<void> => {
  if (isScrolling.value) return;
  const position = positionHoverCard(rect);
  hover.x = position.x;
  hover.y = position.y;
  hover.commitId = commit.id;
  hoverCommit.value = commit;
  hoverAuthorSnapshot.value = null;
  hover.open = true;
  void adjustHoverCardPosition();
  void hydrateHoverGithubAuthor(commit);
  if (hoverDetail.value?.id === commit.id) return;
  hoverDetail.value = null;
  hoverLoading.value = true;
  try {
    const detail = await gitStore.loadCommitDetail(commit.id);
    if (hover.commitId === commit.id) {
      hoverDetail.value = detail;
      void adjustHoverCardPosition();
    }
  } catch {
    // 详情失败时保留摘要回退
  } finally {
    if (hover.commitId === commit.id) hoverLoading.value = false;
  }
};

const handleRowEnter = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
  if (menu.open || isScrolling.value) return;
  clearHoverCloseTimer();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const rect = target.getBoundingClientRect();
  clearHoverOpenTimer();
  hoverOpenTimer = setTimeout(() => {
    void openHoverCard(rect, commit);
  }, HOVER_OPEN_DELAY);
};

const handleRowLeave = (): void => {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  hoverCloseTimer = setTimeout(closeHoverCard, HOVER_CLOSE_DELAY);
};

const handleCardEnter = (): void => {
  clearHoverCloseTimer();
};
const handleCardLeave = (): void => {
  handleRowLeave();
};

const copyHoverCommitId = async (): Promise<void> => {
  const commitId = hoverDetail.value?.id ?? hoverCommit.value?.id;
  if (commitId) await writeClipboardText(commitId);
};

const openHoverCommitOnGithub = (): void => {
  const url = hoverGithubCommitUrl.value;
  if (url) openExternalUrl(url);
};

const closeMenu = (): void => {
  menu.open = false;
  menu.commit = null;
};

const handleContextMenu = (event: MouseEvent, commit: IGitCommitSummaryPayload): void => {
  event.preventDefault();
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  closeHoverCard();
  activeCommitId.value = commit.id;
  menu.commit = commit;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.open = true;
  if (!gitStore.pullRequestSupport.repositoryUrl) {
    void gitStore.loadPullRequestSupport().catch(() => undefined);
  }
};

const handleMenuSelect = async (item: ILinearContextMenuItem): Promise<void> => {
  const commit = menu.commit;
  closeMenu();
  if (!commit) return;

  if (item.key === 'copy-sha') {
    await writeClipboardText(commit.id);
    return;
  }
  if (item.key === 'copy-short') {
    await writeClipboardText(commit.shortId);
    return;
  }
  if (item.key === 'copy-message') {
    await writeClipboardText(commit.summary);
    return;
  }

  if (item.key === 'checkout-commit') {
    try {
      await gitStore.checkoutCommit(commit.id);
    } catch (error) {
      console.error('[GitHistoryGraph] checkout commit failed:', error);
    }
    return;
  }

  if (item.key === 'revert-commit') {
    try {
      await gitStore.revertCommit(commit.id);
    } catch (error) {
      console.error('[GitHistoryGraph] revert commit failed:', error);
    }
    return;
  }

  if (item.key === 'open-github') {
    const repoUrl = gitStore.pullRequestSupport.repositoryUrl;
    if (repoUrl) openExternalUrl(`${repoUrl}/commit/${commit.id}`);
  }
};

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (!menu.open) return;
  const target = event.target;
  if (target instanceof Element && target.closest('.linear-context-menu-root')) return;
  closeMenu();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return;
  if (menu.open) closeMenu();
  if (hover.open) {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    closeHoverCard();
  }
};

const handleWindowResize = (): void => {
  if (menu.open) closeMenu();
  if (hover.open) {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
    closeHoverCard();
  }
};

// req5: 滚动历史列表时关闭并抑制悬浮卡片,滚动停止 180ms 后恢复。
const handleHistoryScroll = (): void => {
  isScrolling.value = true;
  clearHoverOpenTimer();
  if (hover.open) closeHoverCard();
  if (scrollSettleTimer !== null) clearTimeout(scrollSettleTimer);
  scrollSettleTimer = setTimeout(() => {
    isScrolling.value = false;
  }, 180);
};

const teardownHistoryScrollListener = (): void => {
  if (historyScrollTarget) {
    historyScrollTarget.removeEventListener('scroll', handleHistoryScroll, historyScrollCapture);
    historyScrollTarget = null;
  }
};

const setupHistoryScrollListener = (): void => {
  teardownHistoryScrollListener();
  if (typeof window === 'undefined') return;
  const scrollEl = rootRef.value?.closest('.source-control-scroll') ?? null;
  if (scrollEl instanceof HTMLElement) {
    historyScrollTarget = scrollEl;
    historyScrollCapture = false;
    scrollEl.addEventListener('scroll', handleHistoryScroll, { passive: true });
  } else {
    historyScrollTarget = window;
    historyScrollCapture = true;
    window.addEventListener('scroll', handleHistoryScroll, { passive: true, capture: true });
  }
};

// 滚动到底部时无限懒加载：哨兵进入(内部滚动容器的)视口就追加下一段历史。
// 每页条数仍由后端默认值(20)决定，这里只负责"滚到底再要一段"，没有总量上限。
const historySentinelRef = ref<HTMLElement | null>(null);
let historyObserver: IntersectionObserver | null = null;

const loadMoreHistory = (): void => {
  if (!gitStore.canLoadMoreCommitHistory || gitStore.isCommitHistoryLoading) return;
  void gitStore.loadCommitHistory({ append: true }).catch((error) => {
    console.error('[GitHistoryGraph] load more commit history failed:', error);
  });
};

const disconnectHistoryObserver = (): void => {
  if (historyObserver) {
    historyObserver.disconnect();
    historyObserver = null;
  }
};

const setupHistoryObserver = (): void => {
  disconnectHistoryObserver();
  const sentinel = historySentinelRef.value;
  if (!sentinel || typeof IntersectionObserver === 'undefined') return;
  // 历史列表渲染在 SourceControlPanel 的 .source-control-scroll 内部滚动容器里，
  // 用它当 IntersectionObserver 的 root，回退到视口。
  const scrollRoot = sentinel.closest('.source-control-scroll');
  historyObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMoreHistory();
    },
    { root: scrollRoot instanceof HTMLElement ? scrollRoot : null, rootMargin: '240px 0px' },
  );
  historyObserver.observe(sentinel);
};

// 哨兵随 canLoadMoreCommitHistory 显隐而挂载/卸载，跟随重建/断开观察器。
watch(historySentinelRef, () => {
  setupHistoryObserver();
});

watch(
  () => props.commits,
  (commits) => {
    if (commits.length === 0) {
      activeCommitId.value = null;
      return;
    }
    const stillExists = commits.some((commit) => commit.id === activeCommitId.value);
    if (!stillExists) activeCommitId.value = commits[0].id;
    // collapse if expanded commit is no longer in list
    if (expandedCommitId.value && !commits.some((c) => c.id === expandedCommitId.value)) {
      expandedCommitId.value = null;
      expandedDetail.value = null;
    }
  },
  { immediate: true },
);

onMounted(() => {
  if (typeof window === 'undefined') return;
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
  window.addEventListener('resize', handleWindowResize);
  setupHistoryObserver();
  setupHistoryScrollListener();
});

onBeforeUnmount(() => {
  clearHoverOpenTimer();
  clearHoverCloseTimer();
  pendingGithubAuthorRequests.clear();
  if (scrollSettleTimer !== null) {
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = null;
  }
  disconnectHistoryObserver();
  teardownHistoryScrollListener();
  if (typeof window === 'undefined') return;
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
  window.removeEventListener('resize', handleWindowResize);
});
</script>

<style scoped>
.git-history-graph.source-control-history-timeline {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 6px 10px 10px 8px;
  text-align: left;
}

.git-history-graph.source-control-history-timeline::before { content: none; }

.git-history-graph-group-header {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px;
  margin-top: 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #818b98;
}

.git-history-graph-group-icon { width: 13px; height: 13px; flex: 0 0 auto; }
.git-history-graph-group-count { margin-left: auto; font-variant-numeric: tabular-nums; }

.git-history-graph-incoming-note {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-sentinel {
  width: 100%;
  height: 1px;
  flex: 0 0 auto;
}

.git-history-graph-row.source-control-history-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  box-sizing: border-box;
  height: 28px;
  min-height: 28px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  background: transparent;
  overflow: hidden;
  text-align: left;
  transition: background 0.14s ease;
}

.git-history-graph-row.source-control-history-item:hover {
  background: rgba(129, 139, 152, 0.12);
}

.git-history-graph-row.source-control-history-item.is-expanded {
  background: rgba(9, 105, 218, 0.07);
  border-radius: 6px 6px 0 0;
}

.git-history-graph-cell { flex: 0 0 auto; height: 28px; display: block; }
.git-history-graph-svg { display: block; overflow: visible; }
.git-history-graph-edge { stroke-width: 1.5; fill: none; }
.git-history-graph-node { stroke: #ffffff; stroke-width: 2; }

.git-history-graph-body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
  overflow: hidden;
}

.git-history-graph-message-text {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #1f2328;
}

.git-history-graph-ref {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  max-width: 120px;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: rgba(129, 139, 152, 0.15);
  color: #59636e;
}

.git-history-graph-ref.is-head { background: rgba(31, 136, 61, 0.15); color: #1a7f37; }
.git-history-graph-ref.is-remote { background: rgba(9, 105, 218, 0.12); color: #0550ae; }
.git-history-graph-ref-icon { width: 10px; height: 10px; flex: 0 0 auto; }
.git-history-graph-ref-name { overflow: hidden; text-overflow: ellipsis; }

/* === Inline file list === */
.git-history-graph-filelist {
  margin: 0 0 4px;
  border: 1px solid #ebedf0;
  border-top: none;
  border-radius: 0 0 6px 6px;
  background: #fbfcfd;
  overflow: hidden;
}

.git-history-graph-filelist-loading,
.git-history-graph-filelist-empty {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  font-size: 11px;
  color: #818b98;
}

.git-history-graph-filelist-spinner {
  width: 12px;
  height: 12px;
  animation: git-history-spin 1s linear infinite;
}

@keyframes git-history-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.git-history-graph-filelist-item { border-bottom: 1px solid rgba(208, 215, 222, 0.4); }
.git-history-graph-filelist-item:last-child { border-bottom: none; }

.git-history-graph-filelist-row {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  color: #1f2328;
  min-height: 24px;
  box-sizing: border-box;
  cursor: pointer;
  transition: background 0.12s ease;
}

.git-history-graph-filelist-row:hover { background: rgba(9, 105, 218, 0.06); }

.git-history-graph-filelist-icon {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #818b98;
}
.git-history-graph-filelist-icon > span { width: 14px; height: 14px; }
.git-history-graph-filelist-icon.is-added { color: #1a7f37; }
.git-history-graph-filelist-icon.is-deleted { color: #cf222e; }
.git-history-graph-filelist-icon.is-renamed { color: #6e40c9; }
.git-history-graph-filelist-icon.is-binary { color: #818b98; }
.git-history-graph-filelist-icon.is-modified { color: #0550ae; }

.git-history-graph-filelist-name {
  flex: 0 0 auto;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.git-history-graph-filelist-renamed {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-history-graph-filelist-path {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 10.5px;
  color: #818b98;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-history-graph-filelist-stat {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.git-history-graph-filelist-stat-add { color: #1a7f37; }
.git-history-graph-filelist-stat-del { color: #cf222e; }

/* Hover card */
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

.git-history-graph-hovercard-open > span:first-child {
  width: 13px;
  height: 13px;
}
</style>
