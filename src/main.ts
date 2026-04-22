import { listShellCommandLabels } from './services/shell-command-catalog';
import { pinia } from './store';
import { initAppTooltipSystem } from './utils/app-tooltip';
import { registerRuntimeDiagnostics, setRuntimeError } from './utils/runtime-diagnostics';

registerRuntimeDiagnostics();
queueMicrotask(() => {
    void listShellCommandLabels();
});

const MESSAGES = {
    vueErrorLabel: 'Vue 组件渲染错误',
    bootstrapErrorLabel: '应用入口加载失败',
} as const;

const resolveErrorDetail = (error: unknown): string => {
    if (error instanceof Error) {
        return error.stack ?? error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error);
    }
};

const renderFatalBootstrapError = (error: unknown): void => {
    const host = document.getElementById('app') ?? document.body;
    if (!host) {
        return;
    }

    const wrapper = document.createElement('section');
    wrapper.setAttribute('role', 'alert');
    wrapper.style.cssText = [
        'display:flex',
        'min-height:100vh',
        'align-items:center',
        'justify-content:center',
        'padding:24px',
        'background:#0b0c0e',
        'color:#e5e7eb',
        'font-family:Consolas, "JetBrains Mono", monospace',
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
        'width:min(780px,100%)',
        'border:1px solid rgba(255,107,122,.28)',
        'border-radius:12px',
        'background:#15171a',
        'padding:20px 24px',
        'box-shadow:0 24px 72px rgba(0,0,0,.36)',
    ].join(';');

    const title = document.createElement('h1');
    title.textContent = MESSAGES.bootstrapErrorLabel;
    title.style.cssText = 'margin:0 0 12px;font-size:18px;color:#ff9aa5;';

    const pre = document.createElement('pre');
    pre.textContent = resolveErrorDetail(error);
    pre.style.cssText = [
        'margin:0',
        'white-space:pre-wrap',
        'word-break:break-word',
        'font-size:12px',
        'line-height:1.7',
        'color:#cbd5e1',
    ].join(';');

    panel.append(title, pre);
    wrapper.appendChild(panel);
    host.replaceChildren(wrapper);
};

const bootstrap = async (): Promise<void> => {
    try {
        await import('./styles.css');

        const [{ createApp }, { getThemeManager }, { default: App }] = await Promise.all([
            import('vue'),
            import('./themes'),
            import('./App.vue'),
        ]);

        getThemeManager().init();

        const app = createApp(App);
        app.use(pinia);
        app.config.errorHandler = (error) => {
            setRuntimeError(MESSAGES.vueErrorLabel, error);
        };

        app.mount('#app');
        initAppTooltipSystem();
    } catch (error) {
        console.error(MESSAGES.bootstrapErrorLabel, error);
        setRuntimeError(MESSAGES.bootstrapErrorLabel, error);
        renderFatalBootstrapError(error);
    }
};

void bootstrap();
