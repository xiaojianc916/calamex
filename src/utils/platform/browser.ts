import { openExternalUrlViaSystem } from '@/services/ipc/opener.service';

const openWithWindow = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

export const openExternalUrl = (url: string): void => {
  void openExternalUrlViaSystem(url).catch(() => {
    openWithWindow(url);
  });
};
