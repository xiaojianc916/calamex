<script setup lang="ts">
import {
  Activity,
  Brain,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  FolderTree,
  GitBranch,
  Globe,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  XCircle,
} from 'lucide-vue-next';
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from 'reka-ui';
import type { Component } from 'vue';
import { computed, ref } from 'vue';

import type { IAgentActivity, TAgentActivityEvent } from '@/types/agent-activity';
import type { IActivityNote, IAiToolCall } from '@/types/ai';
import {
  buildActivityFeedBlocks,
  type IActivityFeedGroup,
  type IActivityFeedRow,
  type TActivityFeedBlock
} from '@/utils/agent-activity-feed';
import type { TToolActionKind } from '@/utils/agent-activity-inline-catalog';

const props = defineProps<{
  toolCalls: IAiToolCall[];
  activityText?: string;
  activityTrail?: string[];
  activityNotes?: IActivityNote[];
  activities?: IAgentActivity[];
  activityEvents?: TAgentActivityEvent[];
}>();

type TOpenState = Record<string, boolean>;

const STATUS_META: Record<IAiToolCall['status'], { label: string }> = {
  pending: { label: '等待中' },
  running: { label: '进行中' },
  succeeded: { label: '已完成' },
  failed: { label: '失败' },
  denied: { label: '已停止' },
};

const ACTION_ICONS: Record<TToolActionKind, Component> = {
  read: FileText,
  fileSearch: Search,
  symbolSearch: Search,
  diagnose: Activity,
  patch: Pencil,
  applyPatch: Pencil,
  execute: Terminal,
  verify: Terminal,
  git: GitBranch,
  knowledge: Brain,
  reasoning: Brain,
  time: Clock3,
  web: Globe,
  webFetch: Globe,
  tree: FolderTree,
  unknown: Activity,
};

const ACTION_SUBTITLES: Record<TToolActionKind, string> = {
  read: '文件读取',
  fileSearch: '工作区搜索',
  symbolSearch: '符号搜索',
  diagnose: '诊断检查',
  patch: '生成修补',
  applyPatch: '文件编辑',
  execute: '终端执行',
  verify: '验证执行',
  git: 'Git 检查',
  knowledge: '知识处理',
  reasoning: '任务规划',
  time: '时间检查',
  web: '联网搜索',
  webFetch: '网页读取',
  tree: '目录浏览',
  unknown: '步骤详情',
};

const groupOpenState = ref<TOpenState>({});
const rowOpenState = ref<TOpenState>({});

const blocks = computed(() =>
  buildActivityFeedBlocks({
    toolCalls: props.toolCalls,
    activityText: props.activityText,
    activityTrail: props.activityTrail,
    activityNotes: props.activityNotes,
    activities: props.activities,
    activityEvents: props.activityEvents,
  }),
);

const hasBlocks = computed(() => blocks.value.length > 0);

const isGroupOpen = (group: IActivityFeedGroup): boolean =>
  groupOpenState.value[group.id] ?? (group.rows.length === 1
    ? group.rows[0]?.status === 'failed'
    : true);

const isRowOpen = (row: IActivityFeedRow): boolean =>
  rowOpenState.value[row.id] ?? row.status === 'failed';

const updateGroupOpen = (groupId: string, open: boolean): void => {
  groupOpenState.value = {
    ...groupOpenState.value,
    [groupId]: open,
  };
};

const updateRowOpen = (rowId: string, open: boolean): void => {
  rowOpenState.value = {
    ...rowOpenState.value,
    [rowId]: open,
  };
};

const getStatusLabel = (status: IAiToolCall['status']): string =>
  STATUS_META[status].label;

const shouldShowStatusText = (status: IAiToolCall['status']): boolean =>
  status !== 'succeeded';

const getRowIcon = (row: IActivityFeedRow): Component => {
  if (row.status === 'running') {
    return LoaderCircle;
  }

  if (row.status === 'failed') {
    return CircleAlert;
  }

  if (row.status === 'denied') {
    return XCircle;
  }

  if (row.status === 'pending') {
    return Clock3;
  }

  return ACTION_ICONS[row.actionKind] ?? CheckCircle2;
};

const getRowSubtitle = (row: IActivityFeedRow): string =>
  ACTION_SUBTITLES[row.actionKind] ?? '步骤详情';

const getGroupIcon = (group: IActivityFeedGroup): Component => {
  if (group.status === 'running') {
    return LoaderCircle;
  }

  if (group.status === 'failed') {
    return CircleAlert;
  }

  if (group.status === 'denied') {
    return XCircle;
  }

  if (group.status === 'pending') {
    return Clock3;
  }

  return CheckCircle2;
};

const getBlockMarkerIcon = (block: TActivityFeedBlock): Component => {
  if (block.kind === 'assistant_note') {
    if (block.note.status === 'streaming') {
      return LoaderCircle;
    }

    return block.note.source === 'narrator' ? Brain : Activity;
  }

  return getGroupIcon(block.group);
};

const isBlockMarkerSpinning = (block: TActivityFeedBlock): boolean =>
  block.kind === 'assistant_note'
    ? block.note.status === 'streaming'
    : block.group.status === 'running';

const getBlockMarkerClasses = (block: TActivityFeedBlock): string[] => {
  if (block.kind === 'assistant_note') {
    return [
      `is-source-${block.note.source}`,
      block.note.status ? `is-status-${block.note.status}` : '',
      `is-tone-${block.note.tone}`,
    ].filter(Boolean);
  }

  return [`is-${block.group.status}`];
};

const getGroupProgressLabel = (group: IActivityFeedGroup): string => {
  if (group.status === 'running' || group.status === 'pending') {
    return `已完成 ${group.completedSteps}/${group.rows.length} 步`;
  }

  return `共 ${group.rows.length} 步`;
};

const getGroupActionCountLabel = (group: IActivityFeedGroup): string =>
  `${group.rows.length} 个动作`;

const getDiffLabel = (
  diff: IActivityFeedGroup['diff'] | IActivityFeedRow['diff'],
): string | null => {
  if (!diff) {
    return null;
  }

  return `+${diff.additions} -${diff.deletions}`;
};

const getGroupPrimaryRow = (group: IActivityFeedGroup): IActivityFeedRow | null =>
  group.rows[0] ?? null;

const isSingleRowGroup = (group: IActivityFeedGroup): boolean =>
  group.rows.length === 1 && Boolean(getGroupPrimaryRow(group));

const getGroupPrimaryRowStatus = (group: IActivityFeedGroup): IAiToolCall['status'] =>
  getGroupPrimaryRow(group)?.status ?? group.status;

const getGroupPrimaryRowDurationLabel = (group: IActivityFeedGroup): string | null =>
  getGroupPrimaryRow(group)?.durationLabel ?? null;

const getGroupPrimaryRowSections = (group: IActivityFeedGroup) =>
  getGroupPrimaryRow(group)?.sections ?? [];

const getGroupPrimaryRowSubtitle = (group: IActivityFeedGroup): string => {
  const row = getGroupPrimaryRow(group);

  return row ? getRowSubtitle(row) : '';
};

const hasUniformGroupActionKind = (group: IActivityFeedGroup): boolean => {
  const primaryRow = getGroupPrimaryRow(group);

  if (!primaryRow) {
    return false;
  }

  return group.rows.every((row) => row.actionKind === primaryRow.actionKind);
};

const getGroupVerbPrefix = (group: IActivityFeedGroup): string =>
  group.status === 'running' || group.status === 'pending' ? '正在' : '已';

const getGroupEyebrow = (group: IActivityFeedGroup): string => {
  const primaryRow = getGroupPrimaryRow(group);

  if (!primaryRow || !hasUniformGroupActionKind(group)) {
    return '工具调用';
  }

  switch (primaryRow.actionKind) {
    case 'read':
      return '已审阅文件';
    case 'fileSearch':
    case 'symbolSearch':
      return '搜索结果';
    case 'web':
    case 'webFetch':
      return '联网';
    case 'applyPatch':
    case 'patch':
      return '编辑';
    case 'execute':
    case 'verify':
      return '运行';
    case 'git':
      return 'Git';
    default:
      return '工具调用';
  }
};

const getGroupDisplayTitle = (group: IActivityFeedGroup): string => {
  const primaryRow = getGroupPrimaryRow(group);

  if (!primaryRow) {
    return group.title;
  }

  if (group.rows.length === 1) {
    return primaryRow.compactLine;
  }

  if (!hasUniformGroupActionKind(group)) {
    return group.title;
  }

  const verbPrefix = getGroupVerbPrefix(group);

  switch (primaryRow.actionKind) {
    case 'read':
      return `${verbPrefix}查看 ${group.rows.length} 个文件`;
    case 'fileSearch':
    case 'symbolSearch':
      return `${verbPrefix}搜索 ${group.rows.length} 个目标`;
    case 'web':
      return `${verbPrefix}联网搜索 ${group.rows.length} 次`;
    case 'webFetch':
      return `${verbPrefix}读取 ${group.rows.length} 个网页`;
    case 'applyPatch':
    case 'patch':
      return `${verbPrefix}编辑 ${group.rows.length} 个文件`;
    case 'execute':
    case 'verify':
      return `${verbPrefix}执行 ${group.rows.length} 个命令`;
    case 'git':
      return `${verbPrefix}查看 ${group.rows.length} 条 Git 操作`;
    case 'tree':
      return `${verbPrefix}查看 ${group.rows.length} 个目录`;
    default:
      return group.title;
  }
};

</script>

<template>
  <section v-if="hasBlocks" class="ai-tool-activity-inline" aria-label="Agent 活动流">
    <TransitionGroup name="ai-tool-feed-motion" tag="ol" class="ai-tool-feed">
      <li v-for="block in blocks" :key="block.id" class="ai-tool-feed-entry" :class="`is-${block.kind}`">
        <span class="ai-tool-entry-rail" aria-hidden="true">
          <span class="ai-tool-entry-marker" :class="getBlockMarkerClasses(block)">
            <component
:is="getBlockMarkerIcon(block)" class="ai-tool-entry-marker-icon"
              :class="{ 'is-spinning': isBlockMarkerSpinning(block) }" />
          </span>
        </span>

        <div class="ai-tool-entry-main">
          <div v-if="block.kind === 'assistant_note'" class="ai-tool-note-line">
            <p
class="ai-tool-note-text" :class="[
              `is-source-${block.note.source}`,
              `is-tone-${block.note.tone}`,
              block.note.status ? `is-status-${block.note.status}` : '',
              block.note.trigger ? `is-trigger-${block.note.trigger}` : '',
            ]">
              <span class="ai-tool-note-body">{{ block.note.text }}</span>
            </p>
          </div>

          <CollapsibleRoot
v-else class="ai-tool-group ai-tool-group-shell" :open="isGroupOpen(block.group)"
            @update:open="(open) => updateGroupOpen(block.group.id, open)">
            <template v-if="isSingleRowGroup(block.group)">
              <CollapsibleTrigger as-child>
                <button
type="button" class="ai-tool-group-header ai-tool-single-row-header"
                  :class="`is-${block.group.status}`">
                  <span class="ai-tool-row-icon-shell" aria-hidden="true">
                    <component
:is="getRowIcon(getGroupPrimaryRow(block.group) ?? block.group.rows[0])"
                      class="ai-tool-row-icon" :class="{
                        'is-spinning': getGroupPrimaryRow(block.group)?.status === 'running',
                        [`is-${getGroupPrimaryRowStatus(block.group)}`]: true,
                      }" />
                  </span>
                  <span class="ai-tool-row-main">
                    <span class="ai-tool-row-text" :title="getGroupPrimaryRow(block.group)?.compactLine">
                      {{ getGroupPrimaryRow(block.group)?.compactLine }}
                    </span>
                    <span class="ai-tool-row-subtitle">{{ getGroupPrimaryRowSubtitle(block.group) }}</span>
                  </span>
                  <span
v-if="shouldShowStatusText(getGroupPrimaryRowStatus(block.group))
                    || getGroupPrimaryRowDurationLabel(block.group)" class="ai-tool-row-meta">
                    <span
v-if="shouldShowStatusText(getGroupPrimaryRowStatus(block.group))" class="ai-tool-status-text"
                      :class="`is-${getGroupPrimaryRowStatus(block.group)}`">
                      {{ getStatusLabel(getGroupPrimaryRowStatus(block.group)) }}
                    </span>
                    <span v-if="getGroupPrimaryRowDurationLabel(block.group)" class="ai-tool-duration-pill">
                      {{ getGroupPrimaryRowDurationLabel(block.group) }}
                    </span>
                  </span>
                  <span class="ai-tool-chevron-shell" aria-hidden="true">
                    <ChevronRight class="ai-tool-chevron" />
                  </span>
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent v-if="getGroupPrimaryRowSections(block.group).length" as-child>
                <div class="ai-tool-detail-panel is-standalone">
                  <section
v-for="section in getGroupPrimaryRowSections(block.group)"
                    :key="`${block.group.id}:section:${section.title}`" class="ai-tool-detail-section"
                    :class="section.tone ? `is-${section.tone}` : ''">
                    <h4 class="ai-tool-detail-heading">{{ section.title }}</h4>
                    <ol class="ai-tool-detail-points">
                      <li
v-for="detail in section.items" :key="`${block.group.id}:detail:${section.title}:${detail}`"
                        class="ai-tool-detail-point" :title="detail">
                        {{ detail }}
                      </li>
                    </ol>
                  </section>
                </div>
              </CollapsibleContent>
            </template>

            <template v-else>
              <CollapsibleTrigger as-child>
                <button type="button" class="ai-tool-group-header" :class="`is-${block.group.status}`">
                  <span class="ai-tool-group-heading">
                    <span class="ai-tool-group-eyebrow">{{ getGroupEyebrow(block.group) }}</span>
                    <span class="ai-tool-group-title">{{ getGroupDisplayTitle(block.group) }}</span>
                    <span class="ai-tool-group-pills">
                      <span class="ai-tool-group-pill is-steps">{{ getGroupProgressLabel(block.group) }}</span>
                      <span class="ai-tool-group-pill is-count">{{ getGroupActionCountLabel(block.group) }}</span>
                      <span v-if="getDiffLabel(block.group.diff)" class="ai-tool-group-pill is-diff">
                        {{ getDiffLabel(block.group.diff) }}
                      </span>
                    </span>
                  </span>
                  <span class="ai-tool-group-header-trailing">
                    <span
v-if="shouldShowStatusText(block.group.status)" class="ai-tool-status-text"
                      :class="`is-${block.group.status}`">
                      {{ getStatusLabel(block.group.status) }}
                    </span>
                    <span class="ai-tool-chevron-shell" aria-hidden="true">
                      <ChevronRight class="ai-tool-chevron" />
                    </span>
                  </span>
                </button>
              </CollapsibleTrigger>

              <CollapsibleContent as-child>
                <ol class="ai-tool-group-rows">
                  <li v-for="row in block.group.rows" :key="row.id" class="ai-tool-row" :class="`is-${row.status}`">
                    <span class="ai-tool-row-branch" aria-hidden="true">
                      <span class="ai-tool-row-branch-node" :class="`is-${row.status}`"></span>
                    </span>
                    <CollapsibleRoot
class="ai-tool-row-details" :open="isRowOpen(row)"
                      @update:open="(open) => updateRowOpen(row.id, open)">
                      <CollapsibleTrigger as-child>
                        <button type="button" class="ai-tool-row-summary">
                          <span class="ai-tool-row-icon-shell" aria-hidden="true">
                            <component
:is="getRowIcon(row)" class="ai-tool-row-icon"
                              :class="{ 'is-spinning': row.status === 'running', [`is-${row.status}`]: true }" />
                          </span>
                          <span class="ai-tool-row-main">
                            <span class="ai-tool-row-text" :title="row.compactLine">{{ row.compactLine }}</span>
                            <span class="ai-tool-row-subtitle">{{ getRowSubtitle(row) }}</span>
                          </span>
                          <span v-if="shouldShowStatusText(row.status) || row.durationLabel" class="ai-tool-row-meta">
                            <span
v-if="shouldShowStatusText(row.status)" class="ai-tool-status-text"
                              :class="`is-${row.status}`">
                              {{ getStatusLabel(row.status) }}
                            </span>
                            <span v-if="row.durationLabel" class="ai-tool-duration-pill">{{ row.durationLabel }}</span>
                          </span>
                          <span class="ai-tool-chevron-shell" aria-hidden="true">
                            <ChevronRight class="ai-tool-chevron" />
                          </span>
                        </button>
                      </CollapsibleTrigger>

                      <CollapsibleContent v-if="row.sections.length" as-child>
                        <div class="ai-tool-detail-panel">
                          <section
v-for="section in row.sections" :key="`${row.id}:section:${section.title}`"
                            class="ai-tool-detail-section" :class="section.tone ? `is-${section.tone}` : ''">
                            <h4 class="ai-tool-detail-heading">{{ section.title }}</h4>
                            <ol class="ai-tool-detail-points">
                              <li
v-for="detail in section.items" :key="`${row.id}:detail:${section.title}:${detail}`"
                                class="ai-tool-detail-point" :title="detail">
                                {{ detail }}
                              </li>
                            </ol>
                          </section>
                        </div>
                      </CollapsibleContent>
                    </CollapsibleRoot>
                  </li>
                </ol>
              </CollapsibleContent>
            </template>
          </CollapsibleRoot>
        </div>
      </li>
    </TransitionGroup>
  </section>
</template>

<style scoped>
.ai-tool-activity-inline {
  width: 100%;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 20px;
}

.ai-tool-feed,
.ai-tool-group-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-tool-feed {
  display: grid;
  gap: 4px;
}

.ai-tool-feed-entry {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  align-items: start;
  column-gap: 10px;
  min-width: 0;
}

.ai-tool-entry-rail {
  position: relative;
  display: flex;
  min-height: 100%;
  justify-content: center;
  padding-top: 3px;
}

.ai-tool-entry-rail::after {
  position: absolute;
  top: 22px;
  bottom: -6px;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: color-mix(in srgb, var(--shell-divider) 72%, transparent);
  content: '';
}

.ai-tool-feed-entry:last-child .ai-tool-entry-rail::after {
  display: none;
}

.ai-tool-entry-marker {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 78%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-panel) 90%, transparent);
  color: var(--text-secondary);
}

.ai-tool-entry-marker.is-running,
.ai-tool-entry-marker.is-status-streaming {
  border-color: color-mix(in srgb, var(--accent-strong) 42%, transparent);
  background: color-mix(in srgb, var(--accent-strong) 16%, var(--surface-panel));
  color: color-mix(in srgb, var(--accent-strong) 88%, var(--text-primary));
}

.ai-tool-entry-marker.is-failed,
.ai-tool-entry-marker.is-note-source-narrator.is-tone-repair,
.ai-tool-entry-marker.is-note-source-narrator.is-tone-warning {
  border-color: color-mix(in srgb, var(--warning) 38%, transparent);
  background: color-mix(in srgb, var(--warning) 12%, var(--surface-panel));
  color: color-mix(in srgb, var(--warning) 88%, var(--text-primary));
}

.ai-tool-entry-marker.is-source-narrator,
.ai-tool-entry-marker.is-note-source-narrator {
  border-color: color-mix(in srgb, var(--accent-strong) 32%, transparent);
  background: color-mix(in srgb, var(--accent-strong) 12%, var(--surface-panel));
}

.ai-tool-entry-marker-icon {
  width: 11px;
  height: 11px;
  stroke-width: 2.1;
}

.ai-tool-entry-main {
  min-width: 0;
}

.ai-tool-note-line,
.ai-tool-group-shell {
  display: grid;
  gap: 4px;
}

.ai-tool-note-line {
  display: flex;
  align-items: flex-start;
  padding: 0 0 6px;
}

.ai-tool-note-text {
  display: block;
  margin: 0;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 20px;
}

.ai-tool-note-body {
  display: block;
  unicode-bidi: plaintext;
  word-break: break-word;
}

.ai-tool-note-text.is-source-narrator:not(.is-status-streaming) .ai-tool-note-body {
  opacity: 0;
  transform: translateY(4px);
  animation: ai-tool-note-focus 140ms cubic-bezier(0.23, 1, 0.32, 1) forwards;
}

.ai-tool-note-text.is-source-narrator.is-status-streaming .ai-tool-note-body::after {
  display: inline-block;
  width: 0.5em;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: -0.12em;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent-strong) 78%, var(--text-secondary));
  opacity: 0.75;
  content: '';
  animation: ai-tool-note-caret 920ms ease-in-out infinite;
}

.ai-tool-note-text.is-tone-repair .ai-tool-note-body,
.ai-tool-note-text.is-trigger-patch_failed .ai-tool-note-body,
.ai-tool-note-text.is-trigger-verification_failed .ai-tool-note-body,
.ai-tool-note-text.is-trigger-test_failed .ai-tool-note-body {
  color: color-mix(in srgb, var(--warning) 88%, var(--text-primary));
}

.ai-tool-group {
  display: grid;
  gap: 4px;
}

.ai-tool-group-shell {
  padding: 0;
}

.ai-tool-group-header,
.ai-tool-row-summary {
  border: 0;
  background: transparent;
  font: inherit;
  text-align: left;
  appearance: none;
}

.ai-tool-group-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px 0 4px;
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-single-row-header {
  grid-template-columns: 20px minmax(0, 1fr) auto 12px;
  align-items: center;
  min-height: 32px;
  padding: 2px 0 4px;
}

.ai-tool-group-heading {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.ai-tool-group-eyebrow {
  color: var(--text-quaternary);
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0.04em;
  line-height: 16px;
  text-transform: uppercase;
}

.ai-tool-group-title {
  min-width: 0;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
}

.ai-tool-group-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-tool-group-pill {
  display: inline-flex;
  align-items: center;
  padding: 0;
  color: var(--text-quaternary);
  font-size: 11px;
  font-weight: 520;
  line-height: 16px;
  white-space: nowrap;
}

.ai-tool-group-pill.is-steps {
  color: color-mix(in srgb, var(--accent-strong) 82%, var(--text-secondary));
}

.ai-tool-group-pill.is-diff {
  color: color-mix(in srgb, var(--success) 82%, var(--text-secondary));
}

.ai-tool-group-header-trailing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: end;
}

.ai-tool-group-rows {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0 0 0 1px;
  list-style: none;
  position: relative;
}

.ai-tool-group-rows::before {
  position: relative;
}

.ai-tool-group-rows::after {
  position: absolute;
  top: 0;
  bottom: 8px;
  left: 5px;
  width: 1px;
  background: color-mix(in srgb, var(--shell-divider) 64%, transparent);
  content: '';
}

.ai-tool-row {
  position: relative;
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  align-items: start;
  column-gap: 8px;
  min-width: 0;
}

.ai-tool-row-branch {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  width: 12px;
  justify-content: center;
  padding-top: 11px;
}

.ai-tool-row-branch::before {
  position: absolute;
  top: 14px;
  left: 5px;
  width: 9px;
  border-top: 1px solid color-mix(in srgb, var(--shell-divider) 64%, transparent);
  content: '';
}

.ai-tool-row-branch-node {
  position: relative;
  z-index: 1;
  width: 6px;
  height: 6px;
  border: 1px solid color-mix(in srgb, var(--surface-panel) 90%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-quaternary) 84%, transparent);
}

.ai-tool-row-branch-node.is-running {
  background: color-mix(in srgb, var(--accent-strong) 84%, transparent);
}

.ai-tool-row-branch-node.is-failed,
.ai-tool-row-branch-node.is-denied {
  background: color-mix(in srgb, var(--danger) 84%, transparent);
}

.ai-tool-row-branch-node.is-pending {
  background: color-mix(in srgb, var(--warning) 76%, transparent);
}

.ai-tool-row-summary {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto 12px;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 32px;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 3px 0;
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-row-icon-shell,
.ai-tool-chevron-shell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ai-tool-row-icon-shell {
  width: 20px;
  min-width: 20px;
  height: 20px;
}

.ai-tool-row-icon {
  width: 13px;
  height: 13px;
  color: color-mix(in srgb, var(--text-quaternary) 84%, transparent);
  stroke-width: 2;
}

.ai-tool-row-icon.is-running {
  color: var(--text-secondary);
}

.ai-tool-row-icon.is-failed,
.ai-tool-row-icon.is-denied {
  color: color-mix(in srgb, var(--danger) 84%, var(--text-secondary));
}

.ai-tool-row-icon.is-pending {
  color: var(--text-quaternary);
}

.ai-tool-row-icon.is-spinning {
  animation: ai-tool-status-spin 900ms linear infinite;
}

.ai-tool-row-text {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 560;
  line-height: 20px;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}

.ai-tool-row-main {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.ai-tool-row-subtitle {
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-tool-row-meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: end;
  align-self: start;
}

.ai-tool-status-text {
  display: inline-flex;
  align-items: center;
  padding: 0;
  color: var(--text-quaternary);
  font-size: 11px;
  font-weight: 520;
  line-height: 16px;
  white-space: nowrap;
}

.ai-tool-status-text.is-running {
  color: var(--text-secondary);
}

.ai-tool-status-text.is-failed,
.ai-tool-status-text.is-denied {
  color: color-mix(in srgb, var(--danger) 84%, var(--text-secondary));
}

.ai-tool-duration-pill {
  display: inline-flex;
  align-items: center;
  padding: 0;
  color: var(--text-quaternary);
  font-size: 11px;
  line-height: 16px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ai-tool-chevron {
  width: 13px;
  height: 13px;
  color: var(--text-quaternary);
  stroke-width: 2;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-group[data-state='open']>.ai-tool-group-header .ai-tool-chevron,
.ai-tool-row-details[data-state='open']>.ai-tool-row-summary .ai-tool-chevron {
  transform: rotate(90deg);
}

.ai-tool-detail-panel {
  display: grid;
  gap: 8px;
  margin: 2px 0 0;
  border-left: 1px solid color-mix(in srgb, var(--shell-divider) 66%, transparent);
  padding: 2px 0 0 12px;
}

.ai-tool-detail-panel.is-standalone {
  margin-top: 2px;
  margin-left: 20px;
}

.ai-tool-detail-section {
  display: grid;
  gap: 6px;
}

.ai-tool-detail-section.is-warning .ai-tool-detail-heading,
.ai-tool-detail-section.is-warning .ai-tool-detail-point {
  color: color-mix(in srgb, var(--warning) 84%, var(--text-secondary));
}

.ai-tool-detail-section.is-danger .ai-tool-detail-heading,
.ai-tool-detail-section.is-danger .ai-tool-detail-point {
  color: color-mix(in srgb, var(--danger) 84%, var(--text-secondary));
}

.ai-tool-detail-heading {
  margin: 0;
  color: var(--text-quaternary);
  font-size: 11px;
  font-weight: 560;
  letter-spacing: 0.02em;
  line-height: 16px;
}

.ai-tool-detail-points {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-tool-detail-point {
  position: relative;
  min-width: 0;
  padding-left: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 19px;
  unicode-bidi: plaintext;
  word-break: break-word;
}

.ai-tool-detail-point::before {
  position: absolute;
  top: 8px;
  left: 0;
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-quaternary) 72%, transparent);
  content: '';
}

.ai-tool-feed-motion-enter-active,
.ai-tool-feed-motion-move {
  transition:
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1),
    opacity 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-tool-feed-motion-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

@media (hover: hover) and (pointer: fine) {

  .ai-tool-group-header:hover,
  .ai-tool-row-summary:hover {
    background: color-mix(in srgb, var(--surface-hover) 28%, transparent);
    color: var(--text-primary);
  }
}

.ai-tool-group-header:active,
.ai-tool-row-summary:active {
  transform: scale(0.998);
}

.ai-tool-group-header:focus-visible,
.ai-tool-row-summary:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-strong) 46%, transparent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {

  .ai-tool-entry-marker-icon.is-spinning,
  .ai-tool-feed-motion-enter-active,
  .ai-tool-feed-motion-move,
  .ai-tool-note-text.is-source-narrator:not(.is-status-streaming) .ai-tool-note-body,
  .ai-tool-note-text.is-source-narrator.is-status-streaming .ai-tool-note-body::after {
    animation: none;
    transition: none;
  }

  .ai-tool-group-header,
  .ai-tool-row-summary,
  .ai-tool-chevron {
    transition: none;
  }
}

@keyframes ai-tool-status-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes ai-tool-note-reveal {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes ai-tool-note-focus {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes ai-tool-note-caret {

  0%,
  100% {
    opacity: 0.2;
    transform: scaleY(0.92);
  }

  50% {
    opacity: 0.92;
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {

  .ai-tool-row-icon.is-spinning,
  .ai-tool-chevron,
  .ai-tool-note-text.is-source-narrator .ai-tool-note-body,
  .ai-tool-note-text.is-source-narrator.is-status-streaming .ai-tool-note-body::after,
  .ai-tool-feed-motion-enter-active,
  .ai-tool-feed-motion-move {
    animation: none;
    transition: none;
  }

  .ai-tool-feed-motion-enter-from {
    opacity: 1;
    transform: none;
  }

  .ai-tool-note-text.is-source-narrator .ai-tool-note-body {
    opacity: 1;
    transform: none;
  }
}
</style>
