import type { TContextBudgetDecisionKind } from '../../streaming/stream-types.js';

export type TContextManagementOwner =
  | 'mastra_memory'
  | 'zed_style_compaction'
  | 'runtime_warning'
  | 'none';

export interface IContextManagementStrategyInput {
  readonly contextBudgetDecision?: TContextBudgetDecisionKind | undefined;
  readonly mastraMemoryEnabled: boolean;
  readonly observationalMemoryEnabled: boolean;
  readonly semanticRecallEnabled: boolean;
}

export interface IContextManagementStrategy {
  readonly owner: TContextManagementOwner;
  readonly shouldRunZedStyleCompaction: boolean;
  readonly shouldRelyOnMastraMemory: boolean;
  readonly reason: string;
}

export const resolveContextManagementStrategy = (
  input: IContextManagementStrategyInput,
): IContextManagementStrategy => {
  if (input.contextBudgetDecision !== 'compact_recommended') {
    if (input.contextBudgetDecision === 'warn_context_limit') {
      return {
        owner: 'runtime_warning',
        shouldRunZedStyleCompaction: false,
        shouldRelyOnMastraMemory: input.mastraMemoryEnabled,
        reason: 'The model context window is too small for a useful compaction pass; surface a warning instead.',
      };
    }

    return {
      owner: 'none',
      shouldRunZedStyleCompaction: false,
      shouldRelyOnMastraMemory: input.mastraMemoryEnabled,
      reason: 'The request still has enough input-token headroom.',
    };
  }

  if (input.mastraMemoryEnabled && input.observationalMemoryEnabled) {
    return {
      owner: 'mastra_memory',
      shouldRunZedStyleCompaction: false,
      shouldRelyOnMastraMemory: true,
      reason: 'Mastra Observational Memory is the primary long-context compression layer; avoid duplicating it with a parallel hand-written compaction pass.',
    };
  }

  if (input.mastraMemoryEnabled && input.semanticRecallEnabled) {
    return {
      owner: 'mastra_memory',
      shouldRunZedStyleCompaction: false,
      shouldRelyOnMastraMemory: true,
      reason: 'Mastra Semantic Recall is configured to retrieve relevant history; prefer the framework memory pipeline before custom compaction.',
    };
  }

  return {
    owner: 'zed_style_compaction',
    shouldRunZedStyleCompaction: true,
    shouldRelyOnMastraMemory: input.mastraMemoryEnabled,
    reason: 'No Mastra long-context memory layer is configured, so a Zed-style handoff compaction is the fallback strategy.',
  };
};
