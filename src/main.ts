import { initAppTooltipSystem } from './utils/app-tooltip';
import { registerRuntimeDiagnostics, setRuntimeError } from './utils/runtime-diagnostics';

registerRuntimeDiagnostics();

interface ITauriBootstrapInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const enableSplashWindowMode = (): void => {
  document.documentElement.classList.add('splash-window-mode');
  document.body.classList.add('splash-window-mode');
};

const showStartupWindow = (): void => {
  const invoke = (window as Window & { __TAURI_INTERNALS__?: ITauriBootstrapInternals })
    .__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') {
    return;
  }

  void invoke('show_startup_window').catch(() => {
    // 浏览器预览模式没有 Tauri 命令，忽略即可。
  });
};

const renderFatalBootstrapError = (error: unknown): void => {
  enableSplashWindowMode();
  showStartupWindow();

  const target = document.querySelector<HTMLDivElement>('#app');
  if (!target) {
    return;
  }

  const message = escapeHtml(error instanceof Error ? error.message : String(error));
  const detail = escapeHtml(error instanceof Error ? error.stack ?? error.message : String(error));

  target.innerHTML = `
    <style>
      #bootstrap-splash,#bootstrap-splash *{box-sizing:border-box}
      #bootstrap-splash{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:0;background:transparent;color:#d1d5db;font-family:Inter,'JetBrains Mono',Consolas,monospace}
      #bootstrap-splash::before{position:absolute;inset:0;background:radial-gradient(circle at 50% 42%,rgba(94,106,210,.16),transparent 42%),radial-gradient(circle at 50% 54%,rgba(255,255,255,.05),transparent 38%);content:'';pointer-events:none}
      #bootstrap-splash .editor{position:relative;z-index:1;width:min(780px,100vw);height:min(520px,100vh);min-height:0;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;border:1px solid #23262b;border-radius:10px;background:#15171a;box-shadow:0 24px 72px rgba(0,0,0,.36),0 1px 0 rgba(255,255,255,.04) inset}
      #bootstrap-splash .editor.error{border-color:rgba(255,107,122,.34);box-shadow:0 24px 72px rgba(0,0,0,.36),0 1px 0 rgba(255,255,255,.04) inset,0 0 0 1px rgba(255,107,122,.08)}
      #bootstrap-splash .top{display:flex;align-items:center;gap:8px;padding:14px 20px;border-bottom:1px solid #23262b;background:#111215}
      #bootstrap-splash .dot{width:10px;height:10px;border-radius:999px}
      #bootstrap-splash .red{background:#da5555}#bootstrap-splash .yellow{background:#e6b349}#bootstrap-splash .green{background:#49c085}
      #bootstrap-splash .title{display:flex;align-items:center;gap:8px;margin-left:16px;color:#a1a8b3;font-size:13px;font-weight:400}
      #bootstrap-splash .log{flex:1;overflow:hidden;padding:26px 32px 18px;background:#15171a;color:#d1d5db;font-size:13px;line-height:1.8}
      #bootstrap-splash .log-line{margin-bottom:10px;color:#c4c9d4;white-space:pre-wrap;word-break:break-word}
      #bootstrap-splash .log-line-error{color:#ff9aa5}
      #bootstrap-splash .log-divider{height:1px;margin:14px 0 16px;background:rgba(255,255,255,.08)}
      #bootstrap-splash .log-pre{margin:0;max-height:100%;overflow:auto;color:#9aa3b5;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
      #bootstrap-splash .progress-wrap{padding:0 32px 28px}
      #bootstrap-splash .progress-bar{width:100%;height:5px;overflow:hidden;border-radius:6px;background:#2b1d21}
      #bootstrap-splash .progress{height:100%;border-radius:6px;background:linear-gradient(90deg,#ff7b88,#ff8e6b)}
      #bootstrap-splash .status{display:flex;align-items:center;justify-content:center;gap:8px;padding-bottom:20px;color:#c2c9d6;font-size:12px}
      #bootstrap-splash .error-indicator{display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center;border-radius:999px;background:rgba(255,107,122,.18);color:#ff9aa5;font-size:11px;font-weight:700}
    </style>
    <section id="bootstrap-splash">
      <div class="editor error">
        <div class="top">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
          <div class="title">&lt;/&gt; system-loader.js</div>
        </div>
        <div class="log">
          <div class="log-line log-line-error">[error] 应用入口加载失败</div>
          <div class="log-line">[message] ${message}</div>
          <div class="log-divider"></div>
          <pre class="log-pre">${detail}</pre>
        </div>
        <div class="progress-wrap">
          <div class="progress-bar error-bar"><div class="progress error-progress" style="width:100%"></div></div>
        </div>
        <div class="status error-status">
          <span class="error-indicator">!</span>
          <span>启动失败，请查看错误日志。</span>
        </div>
      </div>
    </section>
  `;
};

const renderBootstrapLoading = (): void => {
  enableSplashWindowMode();
  showStartupWindow();

  const target = document.querySelector<HTMLDivElement>('#app');
  if (!target) {
    return;
  }

  if (target.querySelector('#bootstrap-splash')) {
    return;
  }

  target.innerHTML = `
    <style>
      #bootstrap-splash,#bootstrap-splash *{box-sizing:border-box}
      #bootstrap-splash{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:0;background:transparent;color:#d1d5db;font-family:Inter,'JetBrains Mono',Consolas,monospace}
      #bootstrap-splash::before{position:absolute;inset:0;background:radial-gradient(circle at 50% 42%,rgba(94,106,210,.16),transparent 42%),radial-gradient(circle at 50% 54%,rgba(255,255,255,.05),transparent 38%);content:'';pointer-events:none}
      #bootstrap-splash .editor{position:relative;z-index:1;width:min(780px,100vw);height:min(520px,100vh);min-height:0;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;border:1px solid #23262b;border-radius:10px;background:#15171a;box-shadow:0 24px 72px rgba(0,0,0,.36),0 1px 0 rgba(255,255,255,.04) inset}
      #bootstrap-splash .editor.error{border-color:rgba(255,107,122,.34);box-shadow:0 24px 72px rgba(0,0,0,.36),0 1px 0 rgba(255,255,255,.04) inset,0 0 0 1px rgba(255,107,122,.08)}
      #bootstrap-splash .top{display:flex;align-items:center;gap:8px;padding:14px 20px;border-bottom:1px solid #23262b;background:#111215}
      #bootstrap-splash .dot{width:10px;height:10px;border-radius:999px}
      #bootstrap-splash .red{background:#da5555}#bootstrap-splash .yellow{background:#e6b349}#bootstrap-splash .green{background:#49c085}
      #bootstrap-splash .title{display:flex;align-items:center;gap:8px;margin-left:16px;color:#a1a8b3;font-size:13px;font-weight:400}
      #bootstrap-splash .code{flex:1;padding:32px;background:#15171a;font-size:15px;line-height:1.9}
      #bootstrap-splash .log{flex:1;overflow:hidden;padding:26px 32px 18px;background:#15171a;color:#d1d5db;font-size:13px;line-height:1.8}
      #bootstrap-splash .log-line{margin-bottom:10px;color:#c4c9d4;white-space:pre-wrap;word-break:break-word}
      #bootstrap-splash .log-line-error{color:#ff9aa5}
      #bootstrap-splash .log-divider{height:1px;margin:14px 0 16px;background:rgba(255,255,255,.08)}
      #bootstrap-splash .log-pre{margin:0;max-height:100%;overflow:auto;color:#9aa3b5;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
      #bootstrap-splash .line{min-height:28.5px;margin-bottom:10px;white-space:pre}
      #bootstrap-splash .keyword{color:#b39ddb}#bootstrap-splash .func{color:#81c7e8}#bootstrap-splash .str{color:#ffd180}#bootstrap-splash .comment{color:#5c6370}#bootstrap-splash .var{color:#ffab91}
      #bootstrap-splash .cursor{display:inline-block;width:2px;height:1.3em;margin:0 2px;border-radius:1px;background:#fff;vertical-align:text-bottom;animation:bootstrapCaret 1s step-end infinite}
      #bootstrap-splash .progress-wrap{padding:0 32px 28px}
      #bootstrap-splash .progress-bar{width:100%;height:5px;overflow:hidden;border-radius:6px;background:#23262b}
      #bootstrap-splash .progress-bar.error-bar{background:#2b1d21}
      #bootstrap-splash .progress{height:100%;width:18%;border-radius:6px;background:#5e6ad2;animation:bootstrapProgress 1.8s ease-in-out infinite}
      #bootstrap-splash .progress.error-progress{background:linear-gradient(90deg,#ff7b88,#ff8e6b);animation:none}
      #bootstrap-splash .status{display:flex;align-items:center;justify-content:center;gap:8px;padding-bottom:20px;color:#6e7681;font-size:12px}
      #bootstrap-splash .status.error-status{color:#c2c9d6}
      #bootstrap-splash .spinner{width:13px;height:13px;border:2px solid rgba(94,106,210,.24);border-top-color:#5e6ad2;border-radius:999px;animation:bootstrapSpin 1s linear infinite}
      #bootstrap-splash .error-indicator{display:inline-flex;width:15px;height:15px;align-items:center;justify-content:center;border-radius:999px;background:rgba(255,107,122,.18);color:#ff9aa5;font-size:11px;font-weight:700}
      @keyframes bootstrapCaret{50%{opacity:0}}@keyframes bootstrapSpin{to{transform:rotate(360deg)}}@keyframes bootstrapProgress{0%{width:16%}50%{width:42%}100%{width:24%}}
    </style>
    <section id="bootstrap-splash">
      <div class="editor">
        <div class="top">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
          <div class="title">&lt;/&gt; system-loader.js</div>
        </div>
        <div class="code">
          <div class="line"><span class="keyword">import</span> { System } <span class="keyword">from</span> <span class="str">'@core/system'</span>;<span class="cursor"></span></div>
          <div class="line"><span class="keyword">const</span> <span class="var">engine</span> = <span class="keyword">new</span> <span class="func">CoreEngine</span>();</div>
          <div class="line"><span class="comment">// Initializing core modules and rendering</span></div>
          <div class="line"><span class="keyword">await</span> <span class="var">engine</span>.<span class="func">startup</span>();</div>
        </div>
        <div class="progress-wrap">
          <div class="progress-bar"><div class="progress"></div></div>
        </div>
        <div class="status">
          <span class="spinner"></span>
          <span>正在初始化资源，请稍候...</span>
        </div>
      </div>
    </section>
  `;
};

const bootstrap = async (): Promise<void> => {
  try {
    renderBootstrapLoading();

    const [{ createApp }, { createPinia }, { default: App }] =
      await Promise.all([
        import('vue'),
        import('pinia'),
        import('./App.vue'),
        import('./styles.css'),
      ]);

    const app = createApp(App);
    app.use(createPinia());
    // TODO: 全局注册 Shadcn Vue 组件，如有需要可在此处添加
    app.config.errorHandler = (error) => {
      setRuntimeError('Vue 组件渲染错误', error);
    };

    app.mount('#app');
    initAppTooltipSystem();
  } catch (error) {
    console.error('应用入口加载失败', error);
    setRuntimeError('应用入口加载失败', error);
    renderFatalBootstrapError(error);
  }
};

void bootstrap();
