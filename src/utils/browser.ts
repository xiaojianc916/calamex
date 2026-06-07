import { invokeTauriCommand } from '@/services/tauri.ipc-runtime';

const openWithWindow = (url: string): void => {
  if (typeof window === 'undefined') {
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
};

export const openExternalUrl = (url: string): void => {
  void invokeTauriCommand<void>('open_external_url', { url }).catch(() => {
    openWithWindow(url);
  });
};
