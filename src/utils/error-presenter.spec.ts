import { AppError } from '@/types/app-error';
import { presentAppError } from '@/utils/error-presenter';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const presenterMocks = vi.hoisted(() => ({
  dialog: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/utils/error-dialog', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/error-dialog')>();
  return {
    ...original,
    presentErrorDialog: presenterMocks.dialog,
  };
});

vi.mock('@/utils/error-toast', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/utils/error-toast')>();
  return {
    ...original,
    presentErrorToast: presenterMocks.toast,
  };
});

describe('presentAppError', () => {
  beforeEach(() => {
    presenterMocks.dialog.mockReset();
    presenterMocks.toast.mockReset();
  });

  it('局部和页面级错误只返回展示模型，不触发全局副作用', async () => {
    const result = await presentAppError(new Error('模型列表加载失败'), {
      presentation: 'inline',
      title: '无法加载模型列表',
    });

    expect(result.model).toMatchObject({
      title: '无法加载模型列表',
      message: '模型列表加载失败',
      presentation: 'inline',
    });
    expect(presenterMocks.toast).not.toHaveBeenCalled();
    expect(presenterMocks.dialog).not.toHaveBeenCalled();
  });

  it('轻量错误路由到 Toast 展示', async () => {
    const error = new AppError({
      code: 'workspace.save-failed',
      message: '网络连接中断。',
      scope: 'ipc',
      traceId: 'trace-save',
    });

    const result = await presentAppError(error, {
      presentation: 'toast',
      title: '保存失败',
    });

    expect(result.model).toMatchObject({
      title: '保存失败',
      presentation: 'toast',
      code: 'workspace.save-failed',
    });
    expect(presenterMocks.toast).toHaveBeenCalledWith(error, {
      presentation: 'toast',
      title: '保存失败',
    });
  });

  it('阻断型错误路由到 Dialog，并返回用户动作', async () => {
    presenterMocks.dialog.mockResolvedValueOnce('confirm');

    const result = await presentAppError(new Error('当前文件没有写入权限。'), {
      presentation: 'dialog',
      title: '无法保存更改',
      confirmText: '另存为',
      dialogId: 'save-denied',
    });

    expect(result.action).toBe('confirm');
    expect(result.model).toMatchObject({
      title: '无法保存更改',
      presentation: 'dialog',
    });
    expect(presenterMocks.dialog).toHaveBeenCalledWith(expect.any(Error), {
      presentation: 'dialog',
      title: '无法保存更改',
      confirmText: '另存为',
      id: 'save-denied',
    });
  });
});
