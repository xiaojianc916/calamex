import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/types/app-error';
import { tauriService } from '../index';

declare global {
  // eslint-disable-next-line no-var
  var __TAURI_INTERNALS__: { invoke?: typeof invoke } | undefined;
}

/**
 * #2 后端错误码灰度：验证 normalizeIpcError 兼容层。format_document 已迁移为
 * typed error，经 tauri-specta Throw 模式以结构化 { code, message } reject，应被归一
 * 为带稳定 code 的 AppError；未迁移的普通错误仍应回退到 ipc.invoke-failed。
 */
describe('normalizeIpcError 兼容层（typed 后端错误码）', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    globalThis.__TAURI_INTERNALS__ = { invoke: invokeMock };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.__TAURI_INTERNALS__ = undefined;
  });

  it('format_document 抛出的结构化 { code, message } 归一为带 code 的 AppError', async () => {
    invokeMock.mockRejectedValue({
      code: 'format.timeout',
      message: 'shfmt 格式化超时（超过 12 秒）。',
    });

    let caughtError: unknown;
    try {
      await tauriService.formatDocument({
        content: 'echo 1',
        languageId: 'shell',
        path: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AppError);
    expect(caughtError).toMatchObject({
      code: 'format.timeout',
      scope: 'ipc',
      message: 'shfmt 格式化超时（超过 12 秒）。',
    });
  });

  it('普通字符串错误仍回退到 ipc.invoke-failed', async () => {
    invokeMock.mockRejectedValue('boom');

    let caughtError: unknown;
    try {
      await tauriService.formatDocument({
        content: 'echo 1',
        languageId: 'shell',
        path: null,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AppError);
    expect(caughtError).toMatchObject({ code: 'ipc.invoke-failed', scope: 'ipc' });
  });
});
