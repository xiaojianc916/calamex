<script setup lang="ts">
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import type { IGitCommitSummaryPayload } from '@/types/git';
import {
  type IGitCommitRef,
  type IGraphRow,
  NODE_RADIUS,
  ROW_HEIGHT,
} from './useGitHistoryGraph';

defineProps<{
  row: IGraphRow;
  graphWidth: number;
  isActive: boolean;
  isExpanded: boolean;
}>();

const emit = defineEmits<{
  select: [commit: IGitCommitSummaryPayload];
  'context-menu': [event: MouseEvent, commit: IGitCommitSummaryPayload];
  'row-enter': [event: MouseEvent, commit: IGitCommitSummaryPayload];
  'row-leave': [];
}>();

const refClass = (commitRef: IGitCommitRef): Record<string, boolean> => ({
  'is-head': commitRef.isHead,
  'is-remote': commitRef.kind === 'remoteBranch',
  'is-local': commitRef.kind === 'localBranch' && !commitRef.isHead,
});

const refIcon = (commitRef: IGitCommitRef): string =>
  commitRef.kind === 'remoteBranch' ? 'cloud' : 'git-branch';
</script>

<template>
  <article
    class="source-control-history-item git-history-graph-row"
    :class="{ 'is-active': isActive, 'is-expanded': isExpanded }"
    @click="emit('select', row.commit)"
    @contextmenu="emit('context-menu', $event, row.commit)"
    @mouseenter="emit('row-enter', $event, row.commit)"
    @mouseleave="emit('row-leave')"
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
        <LucideIcon :name="refIcon(commitRef)" class="git-history-graph-ref-icon" aria-hidden="true" />
        <span class="git-history-graph-ref-name" v-text="commitRef.name" />
      </span>
    </div>
  </article>
</template>

<style scoped>
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

.git-history-graph-cell {
  flex: 0 0 auto;
  height: 28px;
  display: block;
}

.git-history-graph-svg {
  display: block;
  overflow: visible;
}

.git-history-graph-edge {
  stroke-width: 1.5;
  fill: none;
}

.git-history-graph-node {
  stroke: #ffffff;
  stroke-width: 2;
}

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

.git-history-graph-ref.is-head {
  background: rgba(31, 136, 61, 0.15);
  color: #1a7f37;
}

.git-history-graph-ref.is-remote {
  background: rgba(9, 105, 218, 0.12);
  color: #0550ae;
}

.git-history-graph-ref-icon {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
}

.git-history-graph-ref-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
