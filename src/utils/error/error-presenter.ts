import type { IResolvedErrorPresentation, TErrorPresentation } from '@/types/app-error';
import type { TAppDialogAction, TAppDialogVariant } from '@/types/dialog';
import { type IPresentErrorDialogOptions, presentErrorDialog } from '@/utils/error/error-dialog';
import {
  type IResolveErrorPresentationOptions,
  resolveErrorPresentation,
} from '@/utils/error/error-presentation';
import { presentErrorToast } from '@/utils/error/error-toast';

export interface IPresentAppErrorOptions extends IResolveErrorPresentationOptions {
  cancelText?: string;
  confirmText?: string;
  dismissText?: string;
  dialogId?: string;
  signal?: AbortSignal;
  variant?: TAppDialogVariant;
}

export interface IPresentAppErrorResult {
  action?: TAppDialogAction;
  model: IResolvedErrorPresentation;
}

const toDialogOptions = (options: IPresentAppErrorOptions): IPresentErrorDialogOptions => {
  const { dialogId, ...dialogOptions } = options;
  return {
    ...dialogOptions,
    ...(dialogId ? { id: dialogId } : {}),
  };
};

const isSideEffectPresentation = (presentation: TErrorPresentation): boolean =>
  presentation === 'toast' || presentation === 'dialog';

export const presentAppError = async (
  error: unknown,
  options: IPresentAppErrorOptions = {},
): Promise<IPresentAppErrorResult> => {
  const model = resolveErrorPresentation(error, options);

  if (!isSideEffectPresentation(model.presentation)) {
    return { model };
  }

  if (model.presentation === 'dialog') {
    const action = await presentErrorDialog(error, toDialogOptions(options));
    return { action, model };
  }

  presentErrorToast(error, options);
  return { model };
};
