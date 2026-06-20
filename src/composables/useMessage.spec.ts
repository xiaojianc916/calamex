import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessage } from '@/composables/useMessage';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('vue-sonner', () => ({
  toast: toastMock,
}));

describe('useMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('error 通过 Sonner toast 弹出，并透传 id/description/duration', () => {
    const handle = useMessage().error('保存失败', {
      id: 'save-error',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
    });

    expect(handle.id).toBe('save-error');
    expect(toastMock.error).toHaveBeenCalledWith('保存失败', {
      id: 'save-error',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
      closeButton: true,
    });
  });

  it('dismiss(id) 关闭对应的 Sonner toast', () => {
    useMessage().dismiss('save-error');
    expect(toastMock.dismiss).toHaveBeenCalledWith('save-error');
  });

  it('成功消息不弹出 Toast，但会清除同 id 上残留的进行中 Toast', () => {
    useMessage().success('保存成功', { id: 'save-ok' });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith('save-ok');
  });

  it('info 提示不弹出 Toast', () => {
    useMessage().info('仅供参考的提示');
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('警告与错误仍然弹出 Toast', () => {
    useMessage().warning('请注意检查输入');
    useMessage().error('操作失败');
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it('loading 进度仍然弹出 Toast', () => {
    useMessage().loading('正在保存…');
    expect(toastMock.loading).toHaveBeenCalledTimes(1);
  });
});
