import { useDialog, type DialogConfirmExtraOptions } from '@/composables/useDialog';
import type { TAppDialogAction, TAppDialogVariant } from '@/types/dialog';
import {
  resolveErrorPresentation,
  type IResolveErrorPresentationOptions,
} from '@/utils/error-presentation';

export interface IPresentErrorDialogOptions
  extends Omit<IResolveErrorPresentationOptions, 'presentation'>,
    DialogConfirmExtraOptions {
  confirmText?: string;
  cancelText?: string;
  dismissText?: string;
  variant?: TAppDialogVariant;
}

const resolveDialogVariant = (
  severity: NonNullable<IResolveErrorPresentationOptions['severity']>,
): TAppDialogVariant => {
  if (severity === 'fatal' || severity === 'error') {
    return 'danger';
  }

  if (severity === 'warning') {
    return 'warning';
  }

  return 'default';
};

const buildDialogDescription = (message: string, code?: string, traceId?: string): string => {
  const diagnostics = [
    code ? `错误编号：${code}` : null,
    traceId ? `追踪 ID：${traceId}` : null,
  ].filter((item): item is string => Boolean(item));

  if (!diagnostics.length) {
    return message;
  }

  return `${message}\n\n${diagnostics.join('\n')}`;
};

export const presentErrorDialog = async (
  error: unknown,
  options: IPresentErrorDialogOptions = {},
): Promise<TAppDialogAction> => {
  const {
    cancelText,
    confirmText,
    dismissText,
    id,
    signal,
    variant,
    ...presentationOptions
  } = options;
  const model = resolveErrorPresentation(error, {
    ...presentationOptions,
    presentation: 'dialog',
  });
  const [primaryAction, secondaryAction] = model.actions;
  const action = await useDialog().confirm(
    {
      title: model.title,
      description: buildDialogDescription(model.message, model.code, model.traceId),
      confirmText: confirmText ?? primaryAction?.label ?? '确认',
      cancelText: cancelText ?? secondaryAction?.label ?? '取消',
      dismissText: dismissText ?? '返回',
      variant: variant ?? resolveDialogVariant(model.severity),
    },
    { id, signal },
  );

  if (action === 'confirm') {
    primaryAction?.onSelect();
  }

  if (action === 'cancel') {
    secondaryAction?.onSelect();
  }

  return action;
};
