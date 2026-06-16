import '@/assets/fonts/inter/inter.css';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { queryClient, setupQueryPersistence } from '@/lib/query-client';
import { applyWindowStage } from '@/services/ipc/window.service';
import { pinia } from '@/store';
import { hydrateAiConversationStorage } from '@/store/plugins/debouncedPersistStorage';
import { hydrateSessionStorage } from '@/store/plugins/tauriSessionStorage';
import { MAIN_WINDOW_LABEL } from '@/utils/app-window';
import { renderFatalBootstrapError } from '@/utils/bootstrap-fatal-error';
import { initEditorScrollbarActivity } from '@/utils/editor-scrollbar-activity';
import { initGitHubAuthHeaderEnhancement } from '@/utils/github-auth-header';
import {
  recordRecursiveUpdateCulprit,
  registerRuntimeDiagnostics,
  reportRuntimeError,
  setRuntimeError,
} from '@/utils/runtime-diagnostics';
import { markStartup, reportStartupTimings } from '@/utils/startup-profiler';

registerRuntimeDiagnostics();
markStartup('main-module-ready');

const MESSAGES = {
  vueErrorLabel: 'Vue render failed',
  bootstrapErrorLabel: 'Application bootstrap failed',
  recursiveUpdateLabel: 'Vue recursive update loop detected',
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

  // fallback：不要在首帧前用 setTimeout(0) 抢主线程；给首屏、输入和窗口显示让路。
  setTimeout(task, timeoutMs);
};

const bootstrap = async (): Promise<void> => {
  try {
    markStartup('bootstrap-start');

    markStartup('global-styles-load-start');
    const globalStylesPromise = import('@/styles.css').then(() => {
      markStartup('global-styles-loaded');
    });

    window.__SH_WINDOW_LABEL__ = MAIN_WINDOW_LABEL;

    markStartup('bootstrap-imports-start');
    const bootstrapModulesPromise = Promise.all([
      import('vue'),
      import('@/themes'),
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

    const prefetchShellCatalogAfterBootstrap = (): void => {
      // 命令目录预热涉及动态 import/解析，属于 P2：必须等 Vue mount 和首屏任务让路后再 idle。
      scheduleIdle(() => {
        markStartup('shell-catalog-prefetch-start');
        void import('@/services/shell/command-catalog')
          .then(({ listShellCommandLabels }) => listShellCommandLabels())
          .then(() => {
            markStartup('shell-catalog-prefetch-done');
          })
          .catch((error: unknown) => {
            markStartup('shell-catalog-prefetch-failed');
            console.warn('命令目录预热失败', error);
          });
      }, 2500);
      markStartup('shell-catalog-prefetch-scheduled');
    };

    const hydrateAiConversationAfterBootstrap = (): void => {
      // AI 历史不是首屏必需：延后到首屏后 idle，避免和 session hydrate / Vue mount 抢 IO。
      scheduleIdle(() => {
        void hydrateAiConversationStorage().catch((error: unknown) => {
          console.warn('AI 会话历史后台 hydrate 失败', error);
        });
      }, 2500);
    };

    // session 快照是首屏(编辑器/工作区状态)恢复所必需的，仍在挂载前阻塞 await。
    // 而 ai-conversation 历史只有懒加载的 AI 面板才会用到——首屏并不需要它就位。
    // 因此把它移出挂载关键路径：在后台并发启动 hydrate，不 await。它带有 300ms 超时
    // 与 reconcile 数据安全逻辑，会在用户真正打开 AI 面板前完成，且绝不会用空态覆盖
    // 磁盘上的历史(详见 debouncedPersistStorage)。
    markStartup('session-storage-hydrate-start');
    await hydrateSessionStorage();
    markStartup('session-storage-hydrated');

    const app = createApp(App);
    markStartup('vue-app-created');

    app.use(pinia);
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    markStartup('vue-plugins-installed');

    // 恢复 vue-query 持久化缓存(PR 列表/详情、commit stats)，等价于原 git store
    // 的 readPersisted* 预读；sync-storage persister 是同步读取，开销与原来一次
    // localStorage 读取相当，放在挂载前以保证首屏能读到快照。
    await setupQueryPersistence();
    markStartup('vue-query-persistence-ready');

    app.config.errorHandler = (error) => {
      reportRuntimeError(MESSAGES.vueErrorLabel, error);
    };

    // Vue 的“Maximum recursive updates exceeded”是通过 warnHandler(而非 errorHandler)路由的：
    // 默认仅 console.warn、且不含触发组件名，在“无报错卡死”场景里极易被忽略，也不会被
    // runtime-diagnostics 的 errorHandler 捕获。这里显式拦截该告警并打印出触发组件名，
    // 并把肇事组件喂给自动埋点(recordRecursiveUpdateCulprit),由其落盘现场、供下次启动读出，
    // 把“某个常驻组件自触发递归更新、反复占满主线程”从黑盒变成可定位的问题。
    app.config.warnHandler = (message: string, instance: unknown, trace: string) => {
      if (message.includes('Maximum recursive updates')) {
        const componentType = (
          instance as { $?: { type?: { __name?: string; name?: string } } } | null
        )?.$?.type;
        const componentName = componentType?.__name ?? componentType?.name ?? '<unknown component>';
        console.error(`${MESSAGES.recursiveUpdateLabel} @ ${componentName}`, { trace });
        recordRecursiveUpdateCulprit(componentName);
        return;
      }

      // 其余告警维持开发期默认可见性(设置 warnHandler 后 Vue 不再自行打印)。
      console.warn(`[Vue warn] ${message}${trace ? `\n${trace}` : ''}`);
    };

    await router.isReady();
    markStartup('router-ready');

    app.mount('#app');
    markStartup('vue-mounted');

    initGitHubAuthHeaderEnhancement();
    initEditorScrollbarActivity();

    prefetchShellCatalogAfterBootstrap();
    hydrateAiConversationAfterBootstrap();

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
