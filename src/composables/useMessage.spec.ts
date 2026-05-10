import { useMessage, type DismissDetail, type MessageDetail } from '@/composables/useMessage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('发送 Sonner toast，同时保留 app-message 事件', () => {
    let eventDetail: MessageDetail | null = null;
    window.addEventListener(
      'app-message',
      (event) => {
        eventDetail = event.detail;
      },
      { once: true },
    );

    const handle = useMessage().error('保存失败', {
      id: 'save-error',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
    });

    expect(handle.id).toBe('save-error');
    expect(eventDetail).toMatchObject({
      id: 'save-error',
      type: 'error',
      message: '保存失败',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
    });
    expect(toastMock.error).toHaveBeenCalledWith('保存失败', {
      id: 'save-error',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
      closeButton: true,
    });
  });

  it('关闭消息时同步关闭 Sonner toast 和旧事件通道', () => {
    let dismissDetail: DismissDetail | null = null;
    window.addEventListener(
      'app-message-dismiss',
      (event) => {
        dismissDetail = event.detail;
      },
      { once: true },
    );

    useMessage().dismiss('save-error');

    expect(toastMock.dismiss).toHaveBeenCalledWith('save-error');
    expect(dismissDetail).toEqual({ id: 'save-error' });
  });
});
