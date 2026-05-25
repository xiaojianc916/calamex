<template>
  <AlertDialog :open="Boolean(dialogState)">
    <AlertDialogPortal v-if="dialogState">
      <AlertDialogContent
ref="dialogPanelRef" class="app-dialog-panel" tabindex="-1"
        :data-variant="dialogState.variant" :aria-labelledby="titleId" :aria-describedby="descriptionId"
        @open-auto-focus="handleOpenAutoFocus">
        <div class="app-dialog-copy">
          <AlertDialogTitle :id="titleId" class="app-dialog-title">
            {{ dialogState.title }}
          </AlertDialogTitle>
          <AlertDialogDescription :id="descriptionId" class="app-dialog-description">
            {{ dialogState.description }}
          </AlertDialogDescription>
        </div>
        <div class="app-dialog-footer">
          <AlertDialogCancel as-child>
            <Button
variant="ghost" size="sm" class="app-dialog-button app-dialog-secondary-button"
              @click="handleAction('cancel')">
              {{ dialogState.cancelText }}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction as-child>
            <Button size="sm" class="app-dialog-button app-dialog-primary-button" @click="handleAction('confirm')">
              {{ dialogState.confirmText }}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialog>
</template>

<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogPortal,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  APP_DIALOG_DISMISS_EVENT,
  APP_DIALOG_EVENT,
  type IAppDialogDismissDetail,
  type IAppDialogEventDetail,
  type TAppDialogAction,
  type TAppDialogVariant,
} from '@/types/dialog';
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { useEventListener } from '@vueuse/core';

type TResolvedDialogState = {
  id: string;
  title: string;
  description: string;
  confirmText: string;
  cancelText: string;
  dismissText: string;
  variant: TAppDialogVariant;
  onAction: (action: TAppDialogAction) => void;
};

const dialogState = ref<TResolvedDialogState | null>(null);
const dialogPanelRef = ref<HTMLElement | { $el?: HTMLElement } | null>(null);

const baseId = useId();
const titleId = `${baseId}-title`;
const descriptionId = `${baseId}-description`;

const getDialogPanelElement = (): HTMLElement | null => {
  if (dialogPanelRef.value instanceof HTMLElement) {
    return dialogPanelRef.value;
  }

  return dialogPanelRef.value?.$el ?? null;
};

const focusDialogPanel = async (): Promise<void> => {
  await nextTick();
  getDialogPanelElement()?.focus();
};

const resolveDialogState = (detail: IAppDialogEventDetail): TResolvedDialogState => ({
  id: detail.id ?? `${baseId}-${Date.now()}`,
  title: detail.title,
  description: detail.description,
  confirmText: detail.confirmText ?? '确认',
  cancelText: detail.cancelText ?? '取消',
  dismissText: detail.dismissText ?? '返回',
  variant: detail.variant ?? 'default',
  onAction: detail.onAction,
});

const handleAction = (action: TAppDialogAction): void => {
  const current = dialogState.value;
  if (!current) {
    return;
  }
  dialogState.value = null;
  current.onAction(action);
};

const handleDialogEvent = (event: Event): void => {
  const customEvent = event as CustomEvent<IAppDialogEventDetail>;
  const detail = customEvent.detail;
  if (!detail) {
    return;
  }
  const previous = dialogState.value;
  dialogState.value = resolveDialogState(detail);
  if (previous) {
    previous.onAction('dismiss');
  }
  void focusDialogPanel();
};

const handleDialogDismissEvent = (event: Event): void => {
  const customEvent = event as CustomEvent<IAppDialogDismissDetail | undefined>;
  const current = dialogState.value;
  if (!current) {
    return;
  }
  const requestedId = customEvent.detail?.id;
  // 无 id 时：dismiss 当前对话框；有 id 时：仅当 id 匹配时才关闭
  if (requestedId && requestedId !== current.id) {
    return;
  }
  handleAction(customEvent.detail?.action ?? 'dismiss');
};

const handleOpenAutoFocus = (event: Event): void => {
  event.preventDefault();
  void focusDialogPanel();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (!dialogState.value) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    handleAction('dismiss');
    return;
  }
  if (event.key !== 'Enter' || event.isComposing) {
    return;
  }
  const target = event.target;
  if (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  ) {
    return;
  }
  event.preventDefault();
  handleAction('confirm');
};

onMounted(() => {
useEventListener(window, APP_DIALOG_EVENT, handleDialogEvent);
useEventListener(window, APP_DIALOG_DISMISS_EVENT, handleDialogDismissEvent);
useEventListener(window, 'keydown', handleWindowKeydown);
});

onBeforeUnmount(() => {
  // 卸载时若仍有未结算的对话框，强制结算避免外部 Promise 悬挂
  const pending = dialogState.value;
  if (pending) {
    dialogState.value = null;
    pending.onAction('dismiss');
  }
});
</script>

<style scoped>
.app-dialog-panel {
  position: fixed;
  left: 50%;
  top: 50%;
  z-index: 1401;
  width: min(360px, calc(100vw - 32px));
  transform: translate(-50%, -50%);
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #ffffff;
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.08),
    0 1px 2px rgba(0, 0, 0, 0.04);
  padding: 20px 20px 14px;
  outline: none;
  -webkit-font-smoothing: antialiased;
  font-family: var(--font-sans, 'PingFang SC', 'Microsoft YaHei', Inter, -apple-system, 'Segoe UI', sans-serif);
  opacity: 1;
  transition:
    transform 0.18s ease,
    opacity 0.15s ease;
}

.app-dialog-copy {
  margin-bottom: 18px;
}

.app-dialog-title {
  margin: 0 0 4px;
  color: #000000;
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
}

.app-dialog-description {
  margin: 0;
  color: #737373;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.app-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.app-dialog-button {
  min-width: 0;
  height: 28px;
  border-radius: 5px;
  padding-inline: 12px;
  font-size: 12.5px;
  font-weight: 400;
  box-shadow: none;
  transform: none;
}

.app-dialog-button:active {
  transform: none;
}

.app-dialog-secondary-button {
  border: 1px solid #e5e7eb;
  background: #ffffff;
  color: #374151;
}

.app-dialog-secondary-button:hover {
  background: #f9fafb;
  color: #111827;
}

.app-dialog-primary-button {
  border-color: transparent;
  background: #009966;
  color: #ffffff;
  font-weight: 500;
}

.app-dialog-primary-button:hover {
  background: #00835a;
  color: #ffffff;
}

.app-dialog-panel[data-variant='danger'] .app-dialog-primary-button {
  background: #ec000b;
}

.app-dialog-panel[data-variant='danger'] .app-dialog-primary-button:hover {
  background: #c90009;
}

.app-dialog-panel[data-state='closed'] {
  transform: translate(-50%, calc(-50% - 4px));
  opacity: 0;
}
</style>
