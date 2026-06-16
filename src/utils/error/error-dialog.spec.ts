import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/types/app-error';
import { APP_DIALOG_EVENT, type IAppDialogEventDetail } from '@/types/dialog';
import { presentErrorDialog } from '@/utils/error/error-dialog';

describe('presentErrorDialog', () => {
  it('把阻断型错误转成全局确认弹窗', async () => {
    const error = new AppError({
      code: 'file.write-denied',
      message: '当前文件没有写入权限。',
      scope: 'ipc',
      traceId: 'trace-write-denied',
    });
    let emittedDetail: IAppDialogEventDetail | null = null;

    window.addEventListener(
      APP_DIALOG_EVENT,
      (event) => {
        emittedDetail = event.detail;
        event.detail.onAction('confirm');
      },
      { once: true },
    );

    const action = await presentErrorDialog(error, {
      title: '无法保存更改',
      confirmText: '另存为',
      cancelText: '取消',
    });

    expect(action).toBe('confirm');
    expect(emittedDetail).toMatchObject({
      title: '无法保存更改',
      confirmText: '另存为',
      cancelText: '取消',
      variant: 'danger',
    });
    expect(emittedDetail?.description).toContain('当前文件没有写入权限。');
    expect(emittedDetail?.description).toContain('错误编号：file.write-denied');
    expect(emittedDetail?.description).toContain('追踪 ID：trace-write-denied');
  });

  it('在用户确认或取消时执行对应错误动作', async () => {
    const retry = vi.fn();
    const cancel = vi.fn();

    window.addEventListener(
      APP_DIALOG_EVENT,
      (event) => {
        event.detail.onAction('cancel');
      },
      { once: true },
    );

    const action = await presentErrorDialog(new Error('授权失败'), {
      actions: [
        { id: 'retry', label: '重试', onSelect: retry },
        { id: 'cancel', label: '取消', onSelect: cancel },
      ],
    });

    expect(action).toBe('cancel');
    expect(retry).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
