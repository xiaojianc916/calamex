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

    queueMicrotask(() => {
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

    markStartup('window-stage-main-start');
    await import('./services/ipc/window.service')
      .then(({ applyWindowStage }) => applyWindowStage({ stage: 'main' }))
      .then(() => {
        markStartup('window-stage-main-done');
      })
      .catch((stageError: unknown) => {
        markStartup('window-stage-main-failed');
        console.error('Application error window reveal failed', stageError);
      });

    reportStartupTimings();
  }
};

void bootstrap();
