// composables/useDialog.ts

import {
  APP_DIALOG_DISMISS_EVENT,
  APP_DIALOG_EVENT,
  type IAppDialogDismissDetail,
  type IAppDialogEventDetail,
  type IAppDialogOptions,
  type TAppDialogAction,
} from '@/types/dialog';
import { createPrefixedId } from '@/utils/core/id';

export interface DialogConfirmExtraOptions {
  /** 透传一个 AbortSignal；abort 时 Promise 以 'dismiss' 结算。 */
  signal?: AbortSignal;
  /** 稳定 id，便于外部通过 dismissDialog(id) 主动关闭。 */
  id?: string;
}

const canDispatchDialog = (): boolean =>
  typeof window !== 'undefined' && typeof window.dispatchEvent === 'function';

/** 按 id 主动关闭对话框；不传 id 则关闭全部。action 默认为 'dismiss'。 */
export function dismissDialog(id?: string, action: TAppDialogAction = 'dismiss'): void {
  if (!canDispatchDialog()) return;
  const detail: IAppDialogDismissDetail = { id, action };
  window.dispatchEvent(
    new CustomEvent<IAppDialogDismissDetail>(APP_DIALOG_DISMISS_EVENT, {
      detail,
    }),
  );
}

export function useDialog() {
  const confirm = (
    options: IAppDialogOptions,
    extra?: DialogConfirmExtraOptions,
  ): Promise<TAppDialogAction> => {
    const { promise, resolve } = Promise.withResolvers<TAppDialogAction>();
    const id = extra?.id ?? createPrefixedId('dlg');

    // 调用方在 options 里可能也传了 onAction，这里要保证两侧都被触发。
    const userOnAction = (
      options as IAppDialogOptions & {
        onAction?: (action: TAppDialogAction) => void;
      }
    ).onAction;

    let settled = false;
    const settle = (action: TAppDialogAction): void => {
      if (settled) return;
      settled = true;
      try {
        cleanup();
      } finally {
        try {
          userOnAction?.(action);
        } finally {
          resolve(action);
        }
      }
    };

    // AbortSignal 支持
    const signal = extra?.signal;
    const handleAbort = (): void => {
      dismissDialog(id, 'dismiss');
      settle('dismiss');
    };

    // 监听外部 dismiss 事件（类型来自全局 WindowEventMap，无需断言）
    const handleExternalDismiss = (
      event: WindowEventMap[typeof APP_DIALOG_DISMISS_EVENT],
    ): void => {
      const detail = event.detail ?? {};
      if (detail.id && detail.id !== id) return;
      settle(detail.action ?? 'dismiss');
    };

    const cleanup = (): void => {
      signal?.removeEventListener('abort', handleAbort);
      if (canDispatchDialog()) {
        window.removeEventListener(APP_DIALOG_DISMISS_EVENT, handleExternalDismiss);
      }
    };

    // 已被 abort：直接结算
    if (signal?.aborted) {
      settle('dismiss');
      return promise;
    }
    signal?.addEventListener('abort', handleAbort, { once: true });

    // SSR / 非浏览器环境：降级，避免 Promise 悬挂
    if (!canDispatchDialog()) {
      settle('dismiss');
      return promise;
    }

    window.addEventListener(APP_DIALOG_DISMISS_EVENT, handleExternalDismiss);

    const detail: IAppDialogEventDetail = {
      dismissText: '取消',
      cancelText: '不保存',
      confirmText: '确认',
      variant: 'default',
      ...options,
      id,
      onAction: (action) => settle(action),
    };

    window.dispatchEvent(new CustomEvent<IAppDialogEventDetail>(APP_DIALOG_EVENT, { detail }));

    return promise;
  };

  return { confirm, dismiss: dismissDialog };
}

export type UseDialogReturn = ReturnType<typeof useDialog>;
