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

export interface MessageHandle {
  id: string;
  update: (message: string, options?: MessageOptions) => MessageHandle;
  dismiss: () => void;
}

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

// 统一管线：每种消息类型 → vue-sonner 渲染策略。vue-sonner 的 <Toaster>（见 App.vue）
// 是唯一的可视化通知通道。null 表示该类型默认不弹窗（success / info 静默，避免频繁打扰），
// 但仍会顺手关闭同 id 上可能残留的进行中 Toast（如 loading 转圈）。
const TOAST_RENDERERS: Record<
  TMessageType,
  ((message: string, options: ExternalToast) => void) | null
> = {
  success: null,
  info: null,
  warning: (message, options) => toast.warning(message, options),
  error: (message, options) => toast.error(message, options),
  loading: (message, options) => toast.loading(message, options),
};

/** 生成消息唯一 ID，复用 utils/core/id.ts 的 UUID 标准实现。*/
const generateMessageId = (): string => createPrefixedId('msg');

const showMessage = (
  type: TMessageType,
  message: string,
  options?: MessageOptions,
): MessageHandle => {
  const id = options?.id ?? generateMessageId();
  const duration = options?.duration ?? DEFAULT_DURATIONS[type];

  const render = TOAST_RENDERERS[type];
  if (render) {
    render(message, toToastOptions({ ...options, id, duration }));
  } else if (options?.id) {
    // 静默类型（success / info）：清除同 id 上可能残留的进行中 Toast（如 loading → success）。
    toast.dismiss(options.id);
  }

  return {
    id,
    update: (nextMessage, nextOptions) =>
      showMessage(type, nextMessage, { ...options, ...nextOptions, id }),
    dismiss: () => toast.dismiss(id),
  };
};

export function useMessage() {
  const factory =
    (type: TMessageType) =>
    (message: string, options?: MessageOptions): MessageHandle =>
      showMessage(type, message, options);

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
        showMessage('success', text, { ...options, id: handle.id });
        return value;
      },
      (reason) => {
        const text = typeof messages.error === 'function' ? messages.error(reason) : messages.error;
        showMessage('error', text, { ...options, id: handle.id });
        throw reason;
      },
    );
  };

  /** 按 id 关闭；不传 id 表示关闭全部。*/
  const dismiss = (id?: string): void => {
    toast.dismiss(id);
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
