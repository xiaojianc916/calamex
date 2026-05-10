import type { IErrorPresentationAction } from '@/types/app-error';
import {
  resolveErrorPresentation,
  type IResolveErrorPresentationOptions,
} from '@/utils/error-presentation';
import { toast } from 'vue-sonner';

const ERROR_TOAST_DURATION_MS = 7_000;
const INFO_TOAST_DURATION_MS = 4_000;

const buildToastAction = (
  action: IErrorPresentationAction | undefined,
): { label: string; onClick: (event: MouseEvent) => void } | undefined => {
  if (!action) {
    return undefined;
  }

  return {
    label: action.label,
    onClick: () => {
      action.onSelect();
    },
  };
};

export const presentErrorToast = (
  error: unknown,
  options: Omit<IResolveErrorPresentationOptions, 'presentation'> = {},
): void => {
  const model = resolveErrorPresentation(error, {
    ...options,
    presentation: 'toast',
  });
  const action = buildToastAction(model.actions[0]);
  const duration = model.severity === 'info' ? INFO_TOAST_DURATION_MS : ERROR_TOAST_DURATION_MS;
  const toastOptions = {
    description: model.message,
    duration,
    closeButton: true,
    ...(action ? { action } : {}),
  };

  if (model.severity === 'warning') {
    toast.warning(model.title, toastOptions);
    return;
  }

  if (model.severity === 'info') {
    toast.info(model.title, toastOptions);
    return;
  }

  toast.error(model.title, toastOptions);
};
