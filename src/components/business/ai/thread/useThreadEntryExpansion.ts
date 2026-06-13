import type { ComputedRef, Ref } from 'vue';
import { reactive, watch } from 'vue';
import type { IAiThreadReasoningEntry, TAiThreadEntry } from './projection';

export interface IThreadEntryExpansion {
  /** 该条目当前是否展开。不可展开的条目恒为 false。 */
  isExpanded: (entry: TAiThreadEntry) => boolean;
  /** 受控设置展开状态（用户操作来源）。 */
  setExpanded: (entry: TAiThreadEntry, expanded: boolean) => void;
  /** 切换展开状态。 */
  toggle: (entry: TAiThreadEntry) => void;
}

const isReasoningEntry = (entry: TAiThreadEntry): entry is IAiThreadReasoningEntry =>
  entry.kind === 'reasoning';

/**
 * 平铺时间线的展开 / 折叠状态。镜像 Zed `entry_view_state` 的 entry 展开模型：
 * - 工具调用：默认折叠，完全由用户控制（`expandedToolCalls`）。
 * - 推理块：流式进行中自动展开，流式结束后自动折叠；一旦用户手动切换过，就尊重
 *   用户意图、不再被自动逻辑改写（`autoExpandedReasoningId` + `userToggledReasoning`，
 *   对齐 Zed `auto_expanded_thinking_block` + `user_toggled_thinking_blocks`）。
 */
export function useThreadEntryExpansion(
  entries: Ref<readonly TAiThreadEntry[]> | ComputedRef<readonly TAiThreadEntry[]>,
): IThreadEntryExpansion {
  const expandedToolCalls = reactive(new Set<string>());
  const expandedReasoning = reactive(new Set<string>());
  const userToggledReasoning = reactive(new Set<string>());

  let autoExpandedReasoningId: string | null = null;

  watch(
    entries,
    (currentEntries) => {
      let streamingReasoningId: string | null = null;

      for (const entry of currentEntries) {
        if (isReasoningEntry(entry) && entry.streaming) {
          streamingReasoningId = entry.id;
        }
      }

      if (streamingReasoningId === autoExpandedReasoningId) {
        return;
      }

      if (autoExpandedReasoningId !== null && !userToggledReasoning.has(autoExpandedReasoningId)) {
        expandedReasoning.delete(autoExpandedReasoningId);
      }

      if (streamingReasoningId !== null && !userToggledReasoning.has(streamingReasoningId)) {
        expandedReasoning.add(streamingReasoningId);
      }

      autoExpandedReasoningId = streamingReasoningId;
    },
    { immediate: true },
  );

  const isExpanded = (entry: TAiThreadEntry): boolean => {
    if (entry.kind === 'tool-call') {
      return expandedToolCalls.has(entry.id);
    }

    if (entry.kind === 'reasoning') {
      return expandedReasoning.has(entry.id);
    }

    return false;
  };

  const applyMembership = (target: Set<string>, id: string, expanded: boolean): void => {
    if (expanded) {
      target.add(id);
    } else {
      target.delete(id);
    }
  };

  const setExpanded = (entry: TAiThreadEntry, expanded: boolean): void => {
    if (entry.kind === 'tool-call') {
      applyMembership(expandedToolCalls, entry.id, expanded);
      return;
    }

    if (entry.kind === 'reasoning') {
      userToggledReasoning.add(entry.id);
      applyMembership(expandedReasoning, entry.id, expanded);
    }
  };

  const toggle = (entry: TAiThreadEntry): void => {
    setExpanded(entry, !isExpanded(entry));
  };

  return { isExpanded, setExpanded, toggle };
}
