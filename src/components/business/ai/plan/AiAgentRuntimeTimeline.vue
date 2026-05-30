<script setup lang="ts">
import { type Component, computed, ref } from 'vue';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Task, TaskContent, TaskItem } from '@/components/ai-elements/task';
import {
  Terminal as AiTerminal,
  TerminalActions,
  TerminalClearButton,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '@/components/ai-elements/terminal';
import AiReasoningCodeBlock from '@/components/business/ai/chat/AiReasoningCodeBlock.vue';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';
import Activity from '~icons/lucide/activity';
import ChevronRight from '~icons/lucide/chevron-right';
import Dot from '~icons/lucide/dot';
import Globe from '~icons/lucide/globe';
import {
  buildTimelineItems,
  COMMAND_TOOL_NAMES,
  getFaviconSource,
  parseReasoningMarkdownBlocks,
  TASK_ICON_MAP,
  tokenizeInlineMarkdown,
  type ITaskNodeItem,
} from './runtime-timeline';

const props = withDefaults(
  defineProps<{
    events: TAgentRuntimeEvent[];
    isStreaming?: boolean;
    isWaitingConfirmation?: boolean;
  }>(),
  {
    isStreaming: false,
    isWaitingConfirmation: false,
  },
);

const timelineItems = computed(() => buildTimelineItems(props.events, props.isWaitingConfirmation));
const expandedTerminalNodeIds = ref<Set<string>>(new Set());
const clearedTerminalNodeOffsets = ref<Record<string, number>>({});

const shouldRenderTimeline = computed(
  () => timelineItems.value.length > 0 || props.isStreaming || props.isWaitingConfirmation,
);

const chainHeaderLabel = computed(() =>
  props.isStreaming || props.isWaitingConfirmation ? '正在思考' : '思考完成',
);

const getTaskIcon = (node: ITaskNodeItem): Component => TASK_ICON_MAP[node.icon];

const hasCommandTerminal = (node: ITaskNodeItem): boolean =>
  Boolean(node.toolName && COMMAND_TOOL_NAMES.has(node.toolName) && node.terminalOutput);

const isTerminalExpanded = (nodeId: string): boolean => expandedTerminalNodeIds.value.has(nodeId);

const getTerminalOutput = (node: ITaskNodeItem): string => {
  const output = node.terminalOutput ?? '';
  const offset = clearedTerminalNodeOffsets.value[node.id] ?? 0;

  return offset > 0 ? output.slice(offset) : output;
};

const toggleTerminalNode = (nodeId: string): void => {
  const next = new Set(expandedTerminalNodeIds.value);

  if (next.has(nodeId)) {
    next.delete(nodeId);
  } else {
    next.add(nodeId);
  }

  expandedTerminalNodeIds.value = next;
};

const handleTerminalClear = (nodeId: string): void => {
  const node = timelineItems.value.find((item) => item.type === 'task' && item.node.id === nodeId);
  const outputLength = node?.type === 'task' ? (node.node.terminalOutput?.length ?? 0) : 0;

  clearedTerminalNodeOffsets.value = {
    ...clearedTerminalNodeOffsets.value,
    [nodeId]: outputLength,
  };
};

const handleWebSourceIconError = (event: Event): void => {
  const target = event.target;

  if (!(target instanceof HTMLImageElement)) {
    return;
  }

  target.onerror = null;
  target.hidden = true;
  target.parentElement?.classList.add('is-fallback');
};

const getTaskStepStatus = (node: ITaskNodeItem): 'complete' | 'active' | 'pending' => {
  if (node.status === 'running') {
    return 'complete';
  }

  if (node.status === 'pending') {
    return 'pending';
  }

  return 'complete';
};

const shouldShowTaskStatus = (node: ITaskNodeItem): boolean => node.status !== 'succeeded';
</script>

<template>
  <ChainOfThought v-if="shouldRenderTimeline" class="ai-runtime-timeline" default-open
    aria-label="Agent Chain of Thought">
    <ChainOfThoughtHeader class="ai-runtime-chain-header">
      <Shimmer v-if="isStreaming || isWaitingConfirmation" as="span" class="ai-runtime-chain-label ai-runtime-chain-label--thinking">
        <span v-text="chainHeaderLabel" />
      </Shimmer>
      <span v-else class="ai-runtime-chain-label ai-runtime-chain-label--done" v-text="chainHeaderLabel" />
    </ChainOfThoughtHeader>

    <ChainOfThoughtContent class="ai-runtime-chain-content">
      <template v-for="item in timelineItems" :key="item.id">
        <ChainOfThoughtStep v-if="item.type === 'reasoning'" class="ai-runtime-step is-reasoning" label="Reasoning"
          status="complete">
          <template #icon>
            <Dot class="ai-runtime-step-icon" aria-hidden="true" />
          </template>

          <div class="agent-line">
            <template v-for="(segment, segmentIndex) in item.segments" :key="`${item.id}:segment:${segmentIndex}`">
              <template v-for="block in parseReasoningMarkdownBlocks(segment)"
                :key="`${item.id}:segment:${segmentIndex}:block:${block.id}`">
                <AiReasoningCodeBlock v-if="block.type === 'code-block'"
                  class="agent-line__segment agent-line__code-block" :code="block.code ?? ''" :language="block.language"
                  :fence-info="block.info" />

                <p v-else-if="block.type === 'paragraph'" class="agent-line__segment agent-line__paragraph">
                  <template v-for="(token, tokenIndex) in tokenizeInlineMarkdown(block.text ?? '')"
                    :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:token:${tokenIndex}`">
                    <strong v-if="token.kind === 'strong'" class="agent-line__strong" v-text="token.text" />
                    <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis" v-text="token.text" />
                    <code v-else-if="token.kind === 'code'" class="agent-line__code" v-text="token.text" />
                    <span v-else v-text="token.text" />
                  </template>
                </p>

                <p v-else-if="block.type === 'heading'" class="agent-line__segment agent-line__heading">
                  <template v-for="(token, tokenIndex) in tokenizeInlineMarkdown(block.text ?? '')"
                    :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:token:${tokenIndex}`">
                    <strong v-if="token.kind === 'strong'" class="agent-line__strong" v-text="token.text" />
                    <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis" v-text="token.text" />
                    <code v-else-if="token.kind === 'code'" class="agent-line__code" v-text="token.text" />
                    <span v-else v-text="token.text" />
                  </template>
                </p>

                <blockquote v-else-if="block.type === 'quote'" class="agent-line__segment agent-line__quote">
                  <template v-for="(token, tokenIndex) in tokenizeInlineMarkdown(block.text ?? '')"
                    :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:token:${tokenIndex}`">
                    <strong v-if="token.kind === 'strong'" class="agent-line__strong" v-text="token.text" />
                    <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis" v-text="token.text" />
                    <code v-else-if="token.kind === 'code'" class="agent-line__code" v-text="token.text" />
                    <span v-else v-text="token.text" />
                  </template>
                </blockquote>

                <ol v-else-if="block.type === 'ordered-list'" class="agent-line__segment agent-line__list">
                  <li v-for="(entry, entryIndex) in block.items ?? []"
                    :key="`${segmentIndex}:${block.id}:entry:${entryIndex}`">
                    <template v-for="(token, tokenIndex) in tokenizeInlineMarkdown(entry)"
                      :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:entry:${entryIndex}:token:${tokenIndex}`">
                      <strong v-if="token.kind === 'strong'" class="agent-line__strong" v-text="token.text" />
                      <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis" v-text="token.text" />
                      <code v-else-if="token.kind === 'code'" class="agent-line__code" v-text="token.text" />
                      <span v-else v-text="token.text" />
                    </template>
                  </li>
                </ol>

                <ul v-else class="agent-line__segment agent-line__list">
                  <li v-for="(entry, entryIndex) in block.items ?? []"
                    :key="`${segmentIndex}:${block.id}:entry:${entryIndex}`">
                    <template v-for="(token, tokenIndex) in tokenizeInlineMarkdown(entry)"
                      :key="`${item.id}:segment:${segmentIndex}:block:${block.id}:entry:${entryIndex}:token:${tokenIndex}`">
                      <strong v-if="token.kind === 'strong'" class="agent-line__strong" v-text="token.text" />
                      <em v-else-if="token.kind === 'emphasis'" class="agent-line__emphasis" v-text="token.text" />
                      <code v-else-if="token.kind === 'code'" class="agent-line__code" v-text="token.text" />
                      <span v-else v-text="token.text" />
                    </template>
                  </li>
                </ul>
              </template>
            </template>
          </div>
        </ChainOfThoughtStep>

        <ChainOfThoughtStep v-else-if="item.type === 'event'" class="ai-runtime-step is-event" :label="item.text"
          status="complete">
          <template #icon>
            <Activity class="ai-runtime-step-icon" aria-hidden="true" />
          </template>
        </ChainOfThoughtStep>

        <ChainOfThoughtStep v-else class="ai-runtime-step is-task" :label="item.node.action"
          :status="getTaskStepStatus(item.node)">
          <template v-if="item.node.shimmerAction || hasCommandTerminal(item.node)" #label>
            <div class="ai-runtime-task-label">
              <Shimmer v-if="item.node.shimmerAction" as="span" class="ai-runtime-task-label__text">
                <span v-text="item.node.action" />
              </Shimmer>
              <span v-else class="ai-runtime-task-label__text" v-text="item.node.action" />
              <button
                v-if="hasCommandTerminal(item.node)"
                type="button"
                class="ai-runtime-terminal-toggle"
                :class="{ 'is-open': isTerminalExpanded(item.node.id) }"
                :aria-expanded="isTerminalExpanded(item.node.id)"
                :aria-label="isTerminalExpanded(item.node.id) ? '收起终端输出' : '展开终端输出'"
                :title="isTerminalExpanded(item.node.id) ? '收起终端输出' : '展开终端输出'"
                @click.stop="toggleTerminalNode(item.node.id)"
              >
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          </template>
          <template #icon>
            <component :is="getTaskIcon(item.node)" class="ai-runtime-step-icon" :class="`is-icon-${item.node.icon}`"
              aria-hidden="true" />
          </template>

          <Task v-if="item.node.tags.length || item.node.tail || item.node.webSearchSources?.length"
            class="ai-runtime-task">
            <TaskContent v-if="item.node.tags.length || item.node.tail || item.node.webSearchSources?.length"
              class="ai-runtime-task-content" :class="{ 'has-web-search-sources': item.node.webSearchSources?.length }">
              <div v-if="item.node.webSearchSources?.length" class="ai-runtime-web-search-sources">
                <div v-for="source in item.node.webSearchSources" :key="`${item.node.id}:source:${source.url}`"
                  class="ai-runtime-web-source-pill" :title="source.url">
                  <span class="ai-runtime-web-source-icon-wrap" aria-hidden="true">
                    <img class="ai-runtime-web-source-icon" :src="getFaviconSource(source.host)" alt="" loading="lazy"
                      decoding="async" @error="handleWebSourceIconError" />
                    <Globe class="ai-runtime-web-source-icon-fallback" />
                  </span>
                  <span class="ai-runtime-web-source-label" v-text="source.displayUrl" />
                </div>
              </div>

              <ChainOfThoughtSearchResults v-if="item.node.tags.length" class="ai-runtime-task-search-results">
                <ChainOfThoughtSearchResult v-for="tag in item.node.tags" :key="`${item.node.id}:tag:${tag}`"
                  class="ai-runtime-task-file" :title="tag">
                  <span v-text="tag" />
                </ChainOfThoughtSearchResult>
              </ChainOfThoughtSearchResults>

              <TaskItem v-if="shouldShowTaskStatus(item.node) && item.node.tail" class="ai-runtime-task-item"
                :class="`is-${item.node.status}`">
                <span v-text="item.node.tail" />
              </TaskItem>
            </TaskContent>
          </Task>

          <div v-if="hasCommandTerminal(item.node) && isTerminalExpanded(item.node.id)" class="ai-runtime-terminal-wrap">
            <AiTerminal
              class="ai-runtime-terminal"
              :auto-scroll="true"
              :is-streaming="item.node.terminalStreaming"
              :output="getTerminalOutput(item.node)"
              @clear="handleTerminalClear(item.node.id)"
            >
              <TerminalHeader>
                <TerminalTitle>
                  <span v-text="item.node.terminalTitle ?? 'Windows 终端'" />
                </TerminalTitle>
                <div class="ai-runtime-terminal-header-actions">
                  <TerminalStatus />
                  <TerminalActions>
                    <TerminalCopyButton />
                    <TerminalClearButton />
                  </TerminalActions>
                </div>
              </TerminalHeader>
              <TerminalContent />
            </AiTerminal>
          </div>
        </ChainOfThoughtStep>
      </template>
    </ChainOfThoughtContent>
  </ChainOfThought>
</template>

<style scoped>
.ai-runtime-timeline {
  max-width: min(100%, 760px);
  padding: 4px 0 2px;
  color: var(--text-tertiary);
  font-size: 14px;
  line-height: 20px;
}

.ai-runtime-chain-header {
  min-height: 24px;
  color: var(--text-tertiary);
  font-size: 14px;
  line-height: 20px;
}

.ai-runtime-chain-header:hover {
  color: var(--text-primary);
}

.ai-runtime-chain-label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.ai-runtime-chain-label--thinking {
  font-weight: 500;
}

.ai-runtime-chain-label--done {
  color: inherit;
}

.ai-runtime-chain-content {
  max-width: min(100%, 720px);
}

.ai-runtime-step {
  min-width: 0;
}

.ai-runtime-step :deep(.space-y-2) {
  min-width: 0;
}

.ai-runtime-step-icon {
  width: 16px;
  height: 16px;
  color: currentColor;
  stroke-width: 2;
}

.agent-line {
  color: currentColor;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.agent-line__segment {
  margin: 0;
}

.agent-line__segment+.agent-line__segment {
  margin-top: 6px;
}

.agent-line__code-block {
  width: 60%;
  max-width: 60%;
  white-space: normal;
}

.agent-line__heading {
  color: var(--text-secondary);
  font-weight: 650;
}

.agent-line__list {
  list-style-position: outside;
  margin-bottom: 0;
  margin-left: 0;
  padding-left: 18px;
  white-space: normal;
}

.agent-line__list li {
  min-width: 0;
  padding-left: 2px;
  white-space: pre-wrap;
}

.agent-line__list li+li {
  margin-top: 3px;
}

.agent-line__list li::marker {
  color: var(--text-tertiary);
}

.agent-line__quote {
  border-left: 2px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  color: var(--text-secondary);
  padding-left: 10px;
}

.agent-line__strong {
  color: inherit;
  font-weight: 650;
}

.agent-line__emphasis {
  color: inherit;
  font-style: italic;
}

.agent-line__code {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--surface-soft) 84%, transparent);
  color: inherit;
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 0 4px;
}

.ai-runtime-task {
  min-width: 0;
}

.ai-runtime-task-label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
}

.ai-runtime-task-label__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.ai-runtime-terminal-toggle {
  display: inline-flex;
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-tertiary);
  cursor: default;
  padding: 0;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.ai-runtime-terminal-toggle:hover {
  border-color: color-mix(in srgb, var(--shell-divider) 72%, transparent);
  background: color-mix(in srgb, var(--surface-soft) 82%, transparent);
  color: var(--text-primary);
}

.ai-runtime-terminal-toggle svg {
  width: 15px;
  height: 15px;
  stroke-width: 2;
  transition: transform 140ms ease;
}

.ai-runtime-terminal-toggle.is-open svg {
  transform: rotate(90deg);
}

.ai-runtime-terminal-wrap {
  min-width: 0;
  width: min(100%, 640px);
  max-width: 100%;
  margin-top: 6px;
  padding-left: 0;
}

.ai-runtime-terminal {
  width: 100%;
  height: 230px;
  box-shadow: none;
}

.ai-runtime-terminal-header-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.ai-runtime-task-content :deep(> div) {
  margin-top: 0;
  border-left-width: 0;
  padding-left: 24px;
}

.ai-runtime-task-content.has-web-search-sources :deep(> div) {
  padding-left: 0;
}

.ai-runtime-task-item {
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.ai-runtime-task-item.is-failed {
  color: color-mix(in srgb, var(--danger) 84%, var(--text-tertiary));
}

.ai-runtime-web-search-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-runtime-web-source-pill {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 72%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
  color: var(--text-secondary);
  padding: 3px 10px;
}

.ai-runtime-web-source-icon-wrap {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.ai-runtime-web-source-icon,
.ai-runtime-web-source-icon-fallback {
  width: 16px;
  height: 16px;
}

.ai-runtime-web-source-icon {
  display: block;
  border-radius: var(--radius-sm);
}

.ai-runtime-web-source-icon-fallback {
  display: none;
  stroke-width: 2;
}

.ai-runtime-web-source-icon-wrap.is-fallback .ai-runtime-web-source-icon-fallback {
  display: block;
}

.ai-runtime-web-source-label {
  min-width: 0;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
  white-space: normal;
}

.ai-runtime-task-file {
  max-width: min(560px, 72vw);
  overflow: hidden;
  text-overflow: ellipsis;
  unicode-bidi: plaintext;
  white-space: nowrap;
}
</style>
