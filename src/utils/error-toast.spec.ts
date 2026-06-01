import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presentErrorToast } from '@/utils/error-toast';
import { toast } from 'vue-sonner';

vi.mock('vue-sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

describe('presentErrorToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('默认以 error 级别展示，标题与描述来自错误模型', () => {
    presentErrorToast(new Error('网络断开'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [title, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(title).toBe('操作失败');
    expect(options).toMatchObject({
      description: '网络断开',
      duration: 7000,
      closeButton: true,
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('warning 级别走 toast.warning', () => {
    presentErrorToast(new Error('表单有误'), { severity: 'warning' });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('info 级别走 toast.info 且时长更短', () => {
    presentErrorToast(new Error('已取消'), { severity: 'info' });
    expect(toast.info).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(toast.info).mock.calls[0] ?? [];
    expect(options).toMatchObject({ duration: 4000 });
  });

  it('携带操作时构造 action，点击触发 onSelect', () => {
    const onSelect = vi.fn();
    presentErrorToast(new Error('失败'), {
      actions: [{ id: 'retry', label: '重试', onSelect }],
    });
    const [, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
    const action = (
      options as { action?: { label: string; onClick: (event: MouseEvent) => void } }
    ).action;
    expect(action?.label).toBe('重试');
    action?.onClick(new MouseEvent('click'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
