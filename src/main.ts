import '@/assets/fonts/inter/inter.css';
import { applyWindowStage } from '@/services/ipc/window.service';
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

// 窗口默认 visible:false。正常路径由 App.vue 在首帧后显示窗口；但若启动早期(App.vue
// 尚未挂载)就抛错，App.vue 的窗口显示逻辑不会执行，致命错误界面将无法被看到。
// 这里在引导失败时兜底显示窗口，确保错误对用户可见。
const revealMainWindowAfterBootstrapFailure = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  const internals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') {
    return;
  }

  try {
    await applyWindowStage({ stage: 'main' });
    markStartup('window-stage-main-bootstrap-failure-reveal');
  } catch (revealError) {
    console.error('启动失败后显示主窗口失败', revealError);
  }
};

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

    // 兜底显示窗口(窗口默认 visible:false)：若 App.vue 已挂载则其内部显示逻辑会处理，
    // 这里主要覆盖 App.vue 挂载前就失败、致命错误界面否则不可见的场景。applyWindowStage
    // 幂等，重复调用安全。
    void revealMainWindowAfterBootstrapFailure();

    reportStartupTimings();
  }
};

void bootstrap();
