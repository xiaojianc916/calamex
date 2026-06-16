import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDesktopRuntime,
  desktopRuntimeReady,
  waitForDesktopRuntime,
} from '@/utils/platform/desktop-runtime';

type WindowWithTauri = Window & {
  __TAURI_INTERNALS__?: { invoke?: unknown };
};

const tauriWindow = window as unknown as WindowWithTauri;

afterEach(() => {
  delete tauriWindow.__TAURI_INTERNALS__;
});

describe('desktop-runtime 检测', () => {
  it('检测到 invoke 函数时判定桌面运行时就绪', async () => {
    tauriWindow.__TAURI_INTERNALS__ = { invoke: () => undefined };
    await expect(waitForDesktopRuntime(0)).resolves.toBe(true);
    expect(desktopRuntimeReady.value).toBe(true);
    await expect(assertDesktopRuntime('保存文件')).resolves.toBeUndefined();
  });

  it('internals 存在但缺少 invoke 时判定未就绪', async () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    await expect(waitForDesktopRuntime(0)).resolves.toBe(false);
    expect(desktopRuntimeReady.value).toBe(false);
  });

  it('浏览器预览模式下 assert 抛出包含场景名的错误', async () => {
    await expect(assertDesktopRuntime('保存文件')).rejects.toThrow(/保存文件.*Tauri 桌面端/);
  }, 10000);
});
