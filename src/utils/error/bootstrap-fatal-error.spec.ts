import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderFatalBootstrapError } from '@/utils/error/bootstrap-fatal-error';

describe('renderFatalBootstrapError', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('在 #app 容器内渲染致命错误面板与堆栈', () => {
    const host = document.createElement('div');
    host.id = 'app';
    document.body.appendChild(host);

    renderFatalBootstrapError(new Error('启动失败'));

    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe('Application bootstrap failed');
    expect(host.querySelector('pre')?.textContent ?? '').toContain('启动失败');
  });

  it('缺少 #app 时回退渲染到 document.body', () => {
    renderFatalBootstrapError('纯字符串错误');
    const pre = document.body.querySelector('[role="alert"] pre');
    expect(pre?.textContent).toBe('纯字符串错误');
  });

  it('非字符串、非 Error 时序列化为 JSON 文本', () => {
    const host = document.createElement('div');
    host.id = 'app';
    document.body.appendChild(host);

    renderFatalBootstrapError({ reason: 'oom', fatal: true });

    expect(host.querySelector('pre')?.textContent ?? '').toContain('"reason": "oom"');
  });
});
