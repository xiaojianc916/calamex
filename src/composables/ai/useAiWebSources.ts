import { computed, readonly, ref } from 'vue';

import { aiService } from '@/services/ipc/ai.service';
import type {
  IAiTaskPlanStep,
  IAiWebActivity,
  IAiWebSearchInput,
  IAiWebSourceEntry,
  TAiWebActivityState,
} from '@/types/ai';
import { toErrorMessage } from '@/utils/error';

const DEFAULT_WEB_FETCH_BYTES = 128 * 1024;
const QUERY_PREVIEW_CHARS = 48;
const STEP_QUERY_MAX_CHARS = 180;

interface IAiWebSourceActionContext {
  stepId?: string;
  stepTitle?: string;
}

const clipText = (value: string, maxChars: number): string => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);

  if (characters.length <= maxChars) {
    return normalized;
  }

  return `${characters.slice(0, maxChars).join('')}…`;
};

const hasWebSearchTool = (step: IAiTaskPlanStep): boolean => step.tools.includes('web_search');

const hasWebFetchTool = (step: IAiTaskPlanStep): boolean => step.tools.includes('web_fetch');

const hasWebTools = (step: IAiTaskPlanStep): boolean =>
  hasWebSearchTool(step) || hasWebFetchTool(step);

const buildStepSearchQuery = (step: IAiTaskPlanStep): string => {
  const query = step.goal.trim() || step.title.trim() || step.expectedOutput.trim();
  return clipText(query, STEP_QUERY_MAX_CHARS);
};

const pickFetchTarget = (sources: IAiWebSourceEntry[]): IAiWebSourceEntry | null => {
  const pendingSources = sources.filter((source) => source.status !== 'fetched');

  return (
    pendingSources.find((source) => source.result.sourceType === 'official') ??
    pendingSources.find((source) => source.result.sourceType === 'docs') ??
    pendingSources[0] ??
    null
  );
};

export const useAiWebSources = () => {
  const sources = ref<IAiWebSourceEntry[]>([]);
  const activity = ref<IAiWebActivity | null>(null);
  const errorMessage = ref('');
  const completedWebToolStepIds = ref<string[]>([]);
  const sequence = ref(1);

  const nextId = (prefix: string): string => {
    const value = sequence.value;
    sequence.value += 1;
    return `${prefix}-${Date.now()}-${value}`;
  };

  const markStepWebToolsCompleted = (stepId: string): void => {
    if (completedWebToolStepIds.value.includes(stepId)) {
      return;
    }

    completedWebToolStepIds.value = [...completedWebToolStepIds.value, stepId];
  };

  const setActivity = (
    state: TAiWebActivityState,
    label: string,
    queryPreview?: string,
    stepId?: string,
  ): void => {
    activity.value = {
      id: nextId('web-activity'),
      state,
      label,
      queryPreview,
      ...(stepId ? { stepId } : {}),
    };
  };

  const isSearching = computed(() => activity.value?.state === 'searching');
  const isFetching = computed(() => sources.value.some((source) => source.status === 'fetching'));

  const search = async (
    input: IAiWebSearchInput,
    context: IAiWebSourceActionContext = {},
  ): Promise<IAiWebSourceEntry[]> => {
    const query = input.query.trim();
    const queryPreview = clipText(query, QUERY_PREVIEW_CHARS);
    errorMessage.value = '';
    setActivity('searching', '正在搜索…', queryPreview, context.stepId);

    try {
      const payload = await aiService.webSearch({
        ...input,
        query,
      });
      const nextSources = payload.results.map((result) => ({
        id: nextId('web-source'),
        query,
        ...(context.stepId ? { stepId: context.stepId } : {}),
        ...(context.stepTitle ? { stepTitle: context.stepTitle } : {}),
        result,
        status: 'search-result' as const,
      }));

      sources.value = nextSources;
      setActivity('done', '搜索完成', queryPreview, context.stepId);
      activity.value = null;

      return nextSources;
    } catch (error) {
      const message = toErrorMessage(error, '网络搜索失败。');
      errorMessage.value = message;
      setActivity('failed', message, queryPreview, context.stepId);
      throw error;
    }
  };

  const fetchSource = async (sourceId: string): Promise<IAiWebSourceEntry> => {
    const current = sources.value.find((source) => source.id === sourceId);

    if (!current) {
      const message = '未找到要读取的网页来源。';
      errorMessage.value = message;
      setActivity('failed', message);
      throw new Error(message);
    }

    const queryPreview = clipText(current.result.title, QUERY_PREVIEW_CHARS);
    errorMessage.value = '';
    setActivity('fetching', '正在读取网页…', queryPreview, current.stepId);
    sources.value = sources.value.map((source) =>
      source.id === sourceId
        ? { ...source, status: 'fetching' as const, errorMessage: undefined }
        : source,
    );

    try {
      const payload = await aiService.webFetch({
        url: current.result.url,
        reason: `读取搜索结果：${current.result.title}`,
        maxBytes: DEFAULT_WEB_FETCH_BYTES,
      });

      let updated: IAiWebSourceEntry | null = null;
      sources.value = sources.value.map((source) => {
        if (source.id !== sourceId) {
          return source;
        }

        updated = {
          ...source,
          status: 'fetched' as const,
          fetchedSource: payload.source,
          errorMessage: undefined,
        };
        return updated;
      });

      setActivity('done', '网页读取完成', queryPreview, current.stepId);
      activity.value = null;

      if (!updated) {
        const message = '网页读取状态同步失败。';
        errorMessage.value = message;
        setActivity('failed', message, queryPreview, current.stepId);
        throw new Error(message);
      }

      return updated;
    } catch (error) {
      const message = toErrorMessage(error, '网页读取失败。');
      errorMessage.value = message;
      sources.value = sources.value.map((source) =>
        source.id === sourceId
          ? { ...source, status: 'failed' as const, errorMessage: message }
          : source,
      );
      setActivity('failed', message, queryPreview, current.stepId);
      throw error;
    }
  };

  const hasCompletedWebToolsForStep = (step: IAiTaskPlanStep): boolean =>
    !hasWebTools(step) || completedWebToolStepIds.value.includes(step.id);

  const shouldRunWebToolsForStep = (step: IAiTaskPlanStep): boolean =>
    hasWebTools(step) && !hasCompletedWebToolsForStep(step);

  const runStepWebTools = async (step: IAiTaskPlanStep): Promise<IAiWebSourceEntry[]> => {
    if (!shouldRunWebToolsForStep(step)) {
      return sources.value.filter((source) => source.stepId === step.id);
    }

    let stepSources = sources.value.filter((source) => source.stepId === step.id);

    if (hasWebSearchTool(step)) {
      stepSources = await search(
        {
          query: buildStepSearchQuery(step),
          intent: 'general',
          maxResults: 5,
          recency: 'any',
        },
        {
          stepId: step.id,
          stepTitle: step.title,
        },
      );
    }

    if (hasWebFetchTool(step)) {
      const target = pickFetchTarget(stepSources);

      if (target) {
        await fetchSource(target.id);
        stepSources = sources.value.filter((source) => source.stepId === step.id);
      }
    }

    markStepWebToolsCompleted(step.id);
    return stepSources;
  };

  const clear = (): void => {
    sources.value = [];
    activity.value = null;
    errorMessage.value = '';
    completedWebToolStepIds.value = [];
  };

  return {
    sources: readonly(sources),
    activity: readonly(activity),
    errorMessage: readonly(errorMessage),
    isSearching,
    isFetching,
    search,
    fetchSource,
    runStepWebTools,
    shouldRunWebToolsForStep,
    hasCompletedWebToolsForStep,
    clear,
  };
};
