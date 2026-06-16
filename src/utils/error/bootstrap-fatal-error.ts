const FATAL_BOOTSTRAP_ERROR_LABEL = 'Application bootstrap failed';

/**
 * 将未知错误转换为可展示文本。
 */
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

/**
 * 在 Vue 未能挂载时渲染最小化的致命错误面板。
 */
export const renderFatalBootstrapError = (error: unknown): void => {
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
    'background:#fafafa',
    'color:#111827',
    'font-family:Consolas, "JetBrains Mono", monospace',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'width:min(780px,100%)',
    'border:1px solid rgba(255,107,122,.28)',
    'border-radius:12px',
    'background:#1c1c1f',
    'padding:20px 24px',
    'box-shadow:0 24px 72px rgba(0,0,0,.36)',
  ].join(';');

  const title = document.createElement('h1');
  title.textContent = FATAL_BOOTSTRAP_ERROR_LABEL;
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
