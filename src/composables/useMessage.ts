// composables/useMessage.ts
import { type ExternalToast, toast } from 'vue-sonner';
import { createPrefixedId } from '@/utils/core/id';

export type TMessageType = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface MessageOptions {
  /** 持续时间（毫秒）。传入 0 或 Infinity 表示不自动关闭。*/
  duration?: number;
  /** 次要说明文本。*/
  description?: string;
  /** 自定义 id；若传入相同 id 会复用/覆盖同一条消息（便于 loading → success 转换）。*/
  id?: string;
  /** 关闭时的回调。*/
  onClose?: () => void;
}

export interface MessageDetail extends MessageOptions {
  id: string;
  type: TMessageType;
  message: string;
  createdAt: number;
}

export interface DismissDetail {
  id?: string;
}

export interface MessageHandle {
  id: string;
  update: (message: string, options?: MessageOptions) => MessageHandle;
  dismiss: () => void;
}

// 全局事件类型增强：订阅方无需再手动断言 event.detail。
declare global {
  interface WindowEventMap {
    'app-message': CustomEvent<MessageDetail>;
    'app-message-dismiss': CustomEvent<DismissDetail>;
  }
}

const APP_MESSAGE_EVENT = 'app-message';
const APP_MESSAGE_DISMISS_EVENT = 'app-message-dismiss';

const DEFAULT_DURATIONS: Record<TMessageType, number> = {
  success: 2400,
  info: 2400,
  warning: 3600,
  error: 4800,
  loading: Number.POSITIVE_INFINITY,
};

const toToastOptions = (options: MessageOptions | undefined): ExternalToast => ({
  ...(options?.id ? { id: options.id } : {}),
  ...(options?.description ? { description: options.description } : {}),
  ...(options?.duration !== undefined ? { duration: options.duration } : {}),
  ...(options?.onClose ? { onDismiss: options.onClose } : {}),
  closeButton: true,
});

const emitToast = (
  type: TMessageType,
  message: string,
  options: MessageOptions | undefined,
): void => {
  const toastOptions = toToastOptions(options);

  // 仅 error / warning / loading 会弹出右上角 Toast。
  // success（成功）与 info（提示）不再弹窗，避免频繁打扰；
  // 若该 id 上已有进行中的 Toast（如 promise() 的 loading 转圈），顺手关闭，避免残留。
  if (type === 'success' || type === 'info') {
    if (options?.id) {
      toast.dismiss(options.id);
    }
    return;
  }

  if (type === 'warning') {
    toast.warning(message, toastOptions);
    return;
  }

  if (type === 'loading') {
    toast.loading(message, toastOptions);
    return;
  }

  toast.error(message, toastOptions);
};

/** 生成消息唯一 ID，复用 utils/core/id.ts 的 UUID 标准实现。 */
const generateMessageId = (): string => createPrefixedId('msg');

const canDispatch = (): boolean =>
  typeof window !== 'undefined' && typeof window.dispatchEvent === 'function';

const dispatchMessage = (
  type: TMessageType,
  message: string,
  options?: MessageOptions,
): MessageHandle => {
  const id = options?.id ?? generateMessageId();
  const duration = options?.duration ?? DEFAULT_DURATIONS[type];

  const detail: MessageDetail = {
    ...options,
    id,
    type,
    message,
    duration,
    createdAt: Date.now(),
  };

  if (canDispatch()) {
    window.dispatchEvent(new CustomEvent<MessageDetail>(APP_MESSAGE_EVENT, { detail }));
  }

  emitToast(type, message, { ...options, id, duration });

  const handle: MessageHandle = {
    id,
    update: (nextMessage, nextOptions) =>
      dispatchMessage(type, nextMessage, { ...options, ...nextOptions, id }),
    dismiss: () => {
      toast.dismiss(id);
      if (!canDispatch()) return;
      window.dispatchEvent(
        new CustomEvent<DismissDetail>(APP_MESSAGE_DISMISS_EVENT, { detail: { id } }),
      );
    },
  };
  return handle;
};

const dispatchDismissAll = (): void => {
  toast.dismiss();
  if (!canDispatch()) return;
  window.dispatchEvent(new CustomEvent<DismissDetail>(APP_MESSAGE_DISMISS_EVENT, { detail: {} }));
};

export function useMessage() {
  // 这里用简单的 window 事件模拟，实际项目建议用 Shadcn Toast/Alert 组件全局实现。
  // 监听方可通过 window.addEventListener('app-message', e => e.detail) 消费。
  const factory =
    (type: TMessageType) =>
    (message: string, options?: MessageOptions): MessageHandle =>
      dispatchMessage(type, message, options);

  const success = factory('success');
  const error = factory('error');
  const warning = factory('warning');
  const info = factory('info');
  const loading = factory('loading');

  /**
   * 把一个 Promise 绑定到一条消息上：进行中显示 loading，成功/失败自动切换文案。
   * 支持 messages 的字符串或函数形式。
   */
  const promise = <T>(
    input: Promise<T> | (() => Promise<T>),
    messages: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((reason: unknown) => string);
    },
    options?: MessageOptions,
  ): Promise<T> => {
    const handle = loading(messages.loading, { ...options, duration: Number.POSITIVE_INFINITY });
    const run = typeof input === 'function' ? input() : input;
    return run.then(
      (value) => {
        const text =
          typeof messages.success === 'function' ? messages.success(value) : messages.success;
        dispatchMessage('success', text, { ...options, id: handle.id });
        return value;
      },
      (reason) => {
        const text = typeof messages.error === 'function' ? messages.error(reason) : messages.error;
        dispatchMessage('error', text, { ...options, id: handle.id });
        throw reason;
      },
    );
  };

  /** 按 id 关闭；不传 id 表示关闭全部。 */
  const dismiss = (id?: string): void => {
    if (!id) {
      dispatchDismissAll();
      return;
    }
    toast.dismiss(id);
    if (!canDispatch()) return;
    window.dispatchEvent(
      new CustomEvent<DismissDetail>(APP_MESSAGE_DISMISS_EVENT, { detail: { id } }),
    );
  };

  return {
    success,
    error,
    warning,
    info,
    loading,
    promise,
    dismiss,
  };
}

export type UseMessageReturn = ReturnType<typeof useMessage>;
