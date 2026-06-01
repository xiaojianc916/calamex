import '@/assets/fonts/inter/inter.css';
import { pinia } from './store';
import { hydrateAiConversationStorage } from './store/plugins/debouncedPersistStorage';
import { hydrateSessionStorage } from './store/plugins/tauriSessionStorage';
import { initAppTooltipSystem } from './utils/app-tooltip';
import { MAIN_WINDOW_LABEL } from './utils/app-window';
import { renderFatalBootstrapError } from './utils/bootstrap-fatal-error';
import { registerRuntimeDiagnostics, setRuntimeError } from './utils/runtime-diagnostics';
import { markStartup, reportStartupTimings } from './utils/startup-profiler';

registerRuntimeDiagnostics();
markStartup('main-module-ready');

const MESSAGES = {
  vueErrorLabel: 'Vue render failed',
  bootstrapErrorLabel: 'Application bootstrap failed',
} as const;

const scheduleIdle = (task: () => void, timeoutMs = 1500): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const idleCallback = window.requestIdleCallback;
  if (typeof idleCallback === 'function') {
    idleCallback(
      () => {
        task();
      },
      { timeout: timeoutMs },
    );
    return;
  }

  // fallback：尽量让出首帧/输入事件
  setTimeout(task, 0);
};

const bootstrap = async (): Promise<void> => {
  try {
    markStartup('bootstrap-start');

    markStartup('global-styles-load-start');
    const globalStylesPromise = import('./styles.css').then(() => {
      markStartup('global-styles-loaded');
    });

    window.__SH_WINDOW_LABEL__ = MAIN_WINDOW_LABEL;

    markStartup('bootstrap-imports-start');
    const bootstrapModulesPromise = Promise.all([
      import('vue'),
      import('./themes'),
      import('./App.vue'),
      import('./router'),
    ]).then((modules) => {
      markStartup('bootstrap-imports-loaded');
      return modules;
    });

    const [bootstrapModules] = await Promise.all([bootstrapModulesPromise, globalStylesPromise]);

    const [{ createApp }, { getThemeManager }, { default: App }, { default: router }] =
      bootstrapModules;

    getThemeManager().init();
    markStartup('theme-manager-ready');

    // 命令目录预热可能涉及较重的动态 import/解析;放到 idle 时间，避免与首屏渲染抢主线程。
    scheduleIdle(() => {
      markStartup('shell-catalog-prefetch-start');
      void import('./services/shell/command-catalog')
        .then(({ listShellCommandLabels }) => listShellCommandLabels())
        .then(() => {
          markStartup('shell-catalog-prefetch-done');
        })
        .catch((error: unknown) => {
          markStartup('shell-catalog-prefetch-failed');
          console.warn('命令目录预热失败', error);
        });
    });
    markStartup('shell-catalog-prefetch-scheduled');

    // session 与 ai-conversation 持久化都是异步 hydrate，必须在 app.use(pinia) 前
    // 完成;二者相互独立，并行 await 以不增加首屏延迟。
    markStartup('session-storage-hydrate-start');
    await Promise.all([hydrateSessionStorage(), hydrateAiConversationStorage()]);
    markStartup('session-storage-hydrated');

    const app = createApp(App);
    markStartup('vue-app-created');

    app.use(pinia);
    app.use(router);
    markStartup('vue-plugins-installed');

    app.config.errorHandler = (error) => {
      setRuntimeError(MESSAGES.vueErrorLabel, error);
    };

    await router.isReady();
    markStartup('router-ready');

    app.mount('#app');
    markStartup('vue-mounted');

    initAppTooltipSystem();
    markStartup('tooltip-system-ready');

    markStartup('bootstrap-done');
  } catch (error) {
    console.error(MESSAGES.bootstrapErrorLabel, error);
    setRuntimeError(MESSAGES.bootstrapErrorLabel, error);
    renderFatalBootstrapError(error);

    // 窗口显示阶段由 App.vue 内部统一处理(监听 runtimeErrorState 与 workbench ready)，
    // 避免在多处重复触发 applyWindowStage 导致竞态。
    reportStartupTimings();
  }
};

void bootstrap();
