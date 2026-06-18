export type TStartupMarkName =
  | 'index-theme-start'
  | 'index-theme-ready'
  | 'main-module-ready'
  | 'bootstrap-start'
  | 'global-styles-load-start'
  | 'global-styles-loaded'
  | 'bootstrap-imports-start'
  | 'bootstrap-imports-loaded'
  | 'theme-manager-ready'
  | 'shell-catalog-prefetch-scheduled'
  | 'shell-catalog-prefetch-start'
  | 'shell-catalog-prefetch-done'
  | 'shell-catalog-prefetch-failed'
  | 'session-storage-hydrate-start'
  | 'session-storage-hydrated'
  | 'vue-app-created'
  | 'vue-plugins-installed'
  | 'router-ready'
  | 'vue-mounted'
  | 'tooltip-system-ready'
  | 'bootstrap-done'
  | 'shell-workbench-mounted'
  | 'workbench-initialize-start'
  | 'workbench-initialize-done'
  | 'workbench-initialize-failed'
  | 'workbench-initial-paint-ready'
  | 'workbench-ready-event'
  | 'restore-session-start'
  | 'restore-session-done'
  | 'restore-session-failed'
  | 'window-stage-main-start'
  | 'window-stage-main-done'
  | 'window-stage-main-failed'
  | 'window-stage-main-skipped'
  | 'ai-copilotkit-import-start'
  | 'ai-copilotkit-import-done'
  | 'ai-copilotkit-provider-setup'
  | 'ai-workspace-surface-import-start'
  | 'ai-workspace-surface-import-done'
  | 'ai-workspace-surface-setup'
  | 'ai-workspace-surface-mounted'
  | 'ai-assistant-panel-setup-start'
  | 'ai-assistant-panel-composables-ready'
  | 'ai-assistant-panel-setup-done'
  | 'ai-assistant-panel-mounted'
  | 'ai-surface-summary-reported'
  | 'startup-summary-reported';

type TStartupMeasureStart = TStartupMarkName | 'navigation-start';

interface IStartupMeasureDefinition {
  key: string;
  label: string;
  start: TStartupMeasureStart;
  end: TStartupMarkName;
}

interface IStartupTimingRow {
  key: string;
  label: string;
  start: TStartupMeasureStart;
  end: TStartupMarkName;
  durationMs: number | null;
  endAtMs: number | null;
}

const STARTUP_MARK_PREFIX = 'calamex:startup:';
const STARTUP_MEASUREMENTS: readonly IStartupMeasureDefinition[] = [
  {
    key: 'index-theme',
    label: 'HTML 主题预设',
    start: 'index-theme-start',
    end: 'index-theme-ready',
  },
  {
    key: 'navigation-to-main-module',
    label: '导航到前端入口',
    start: 'navigation-start',
    end: 'main-module-ready',
  },
  {
    key: 'global-styles-load',
    label: '全局样式加载',
    start: 'global-styles-load-start',
    end: 'global-styles-loaded',
  },
  {
    key: 'bootstrap-imports',
    label: '核心模块动态加载',
    start: 'bootstrap-imports-start',
    end: 'bootstrap-imports-loaded',
  },
  {
    key: 'session-storage-hydrate',
    label: '会话快照水合',
    start: 'session-storage-hydrate-start',
    end: 'session-storage-hydrated',
  },
  {
    key: 'router-ready',
    label: '路由就绪',
    start: 'vue-plugins-installed',
    end: 'router-ready',
  },
  {
    key: 'vue-mount',
    label: 'Vue 挂载',
    start: 'router-ready',
    end: 'vue-mounted',
  },
  {
    key: 'workbench-initialize',
    label: '工作台初始化',
    start: 'workbench-initialize-start',
    end: 'workbench-initialize-done',
  },
  {
    key: 'initial-workbench-paint',
    label: '工作台首帧等待',
    start: 'workbench-initialize-done',
    end: 'workbench-initial-paint-ready',
  },
  {
    key: 'native-window-stage',
    label: '主窗口显示阶段',
    start: 'window-stage-main-start',
    end: 'window-stage-main-done',
  },
  {
    key: 'shell-catalog-prefetch',
    label: '命令目录预热',
    start: 'shell-catalog-prefetch-start',
    end: 'shell-catalog-prefetch-done',
  },
  {
    key: 'restore-session',
    label: '会话恢复',
    start: 'restore-session-start',
    end: 'restore-session-done',
  },
  {
    key: 'bootstrap-total',
    label: '前端启动总段',
    start: 'bootstrap-start',
    end: 'bootstrap-done',
  },
];

// AI 主界面真身（CopilotKit Provider + AiWorkspaceSurface + AiAssistantPanel）是
// 启动关键路径之外的延迟挂载链路，其分段不在上面的总览里。这里单独定义一组测量,
// 由 reportAiSurfaceStartupTimings 在真身首帧后输出,用于定位「AI 首屏异常缓慢」。
const AI_SURFACE_STARTUP_MEASUREMENTS: readonly IStartupMeasureDefinition[] = [
  {
    key: 'ai-copilotkit-import',
    label: 'CopilotKit Provider 动态加载',
    start: 'ai-copilotkit-import-start',
    end: 'ai-copilotkit-import-done',
  },
  {
    key: 'ai-workspace-surface-import',
    label: 'AI 工作区真身动态加载',
    start: 'ai-workspace-surface-import-start',
    end: 'ai-workspace-surface-import-done',
  },
  {
    key: 'ai-workspace-surface-mount',
    label: 'AI 工作区 setup + 挂载',
    start: 'ai-workspace-surface-setup',
    end: 'ai-workspace-surface-mounted',
  },
  {
    key: 'ai-assistant-panel-composables',
    label: 'AI 面板核心 composable 初始化',
    start: 'ai-assistant-panel-setup-start',
    end: 'ai-assistant-panel-composables-ready',
  },
  {
    key: 'ai-assistant-panel-derivations',
    label: 'AI 面板派生计算构建',
    start: 'ai-assistant-panel-composables-ready',
    end: 'ai-assistant-panel-setup-done',
  },
  {
    key: 'ai-assistant-panel-children-mount',
    label: 'AI 面板子组件渲染挂载',
    start: 'ai-assistant-panel-setup-done',
    end: 'ai-assistant-panel-mounted',
  },
  {
    key: 'ai-surface-total',
    label: 'AI 首屏真身总段',
    start: 'ai-copilotkit-import-start',
    end: 'ai-workspace-surface-mounted',
  },
];

const toMarkName = (name: TStartupMarkName): string => `${STARTUP_MARK_PREFIX}${name}`;

const roundDuration = (value: number): number => Math.round(value * 10) / 10;

const hasPerformanceMark = (): boolean =>
  typeof performance !== 'undefined' && typeof performance.mark === 'function';

const readLastPerformanceEntry = (name: string): PerformanceEntry | null => {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
    return null;
  }

  const entries = performance.getEntriesByName(name);
  return entries[entries.length - 1] ?? null;
};

const readMarkTime = (name: TStartupMeasureStart): number | null => {
  if (name === 'navigation-start') {
    return 0;
  }

  const entry = readLastPerformanceEntry(toMarkName(name));
  return entry ? entry.startTime : null;
};

const shouldEmitStartupLogs = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  // 默认只在开发模式输出;如需在 release 中定位启动慢问题，可在控制台临时设置:
  //   window.__CALAMEX_STARTUP_DEBUG__ = true
  const debugFlag = (window as unknown as { __CALAMEX_STARTUP_DEBUG__?: boolean })
    .__CALAMEX_STARTUP_DEBUG__;
  return Boolean(debugFlag) || Boolean(import.meta.env.DEV);
};

const emitStartupLog = (payload: Record<string, unknown>): void => {
  if (!shouldEmitStartupLogs()) {
    return;
  }

  console.info(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      scope: 'startup',
      ...payload,
    }),
  );
};

const buildTimingRow = (definition: IStartupMeasureDefinition): IStartupTimingRow => {
  const startAt = readMarkTime(definition.start);
  const endAt = readMarkTime(definition.end);
  const durationMs =
    startAt === null || endAt === null ? null : roundDuration(Math.max(0, endAt - startAt));

  return {
    key: definition.key,
    label: definition.label,
    start: definition.start,
    end: definition.end,
    durationMs,
    endAtMs: endAt === null ? null : roundDuration(endAt),
  };
};

export const markStartup = (name: TStartupMarkName): void => {
  if (!hasPerformanceMark()) {
    return;
  }

  try {
    performance.mark(toMarkName(name));
    const markTime = readMarkTime(name);
    emitStartupLog({
      event: 'frontend.mark',
      mark: name,
      atMs: markTime === null ? null : roundDuration(markTime),
    });
  } catch (error) {
    console.warn('启动打点写入失败', error);
  }
};

export const reportStartupTimings = (): void => {
  if (!hasPerformanceMark() || readMarkTime('startup-summary-reported') !== null) {
    return;
  }

  markStartup('startup-summary-reported');

  const timings = STARTUP_MEASUREMENTS.map(buildTimingRow);
  const endAt =
    readMarkTime('window-stage-main-done') ??
    readMarkTime('window-stage-main-skipped') ??
    readMarkTime('window-stage-main-failed') ??
    readMarkTime('workbench-ready-event') ??
    readMarkTime('vue-mounted');
  const totalMs = endAt === null ? null : roundDuration(endAt);

  emitStartupLog({
    event: 'frontend.summary',
    totalMs,
    timings,
  });

  if (shouldEmitStartupLogs() && typeof console.table === 'function') {
    console.table(timings);
  }
};

// 输出 AI 主界面真身的延迟挂载分段。由 AiWorkspaceSurface 在首帧绘制后调用,
// 因此与启动总览（reportStartupTimings,挂在窗口显示阶段）相互独立、互不覆盖。
export const reportAiSurfaceStartupTimings = (): void => {
  if (!hasPerformanceMark() || readMarkTime('ai-surface-summary-reported') !== null) {
    return;
  }

  markStartup('ai-surface-summary-reported');

  const timings = AI_SURFACE_STARTUP_MEASUREMENTS.map(buildTimingRow);
  const endAt = readMarkTime('ai-workspace-surface-mounted');
  const totalMs = endAt === null ? null : roundDuration(endAt);

  emitStartupLog({
    event: 'frontend.ai-surface-summary',
    totalMs,
    timings,
  });

  if (shouldEmitStartupLogs() && typeof console.table === 'function') {
    console.table(timings);
  }
};
