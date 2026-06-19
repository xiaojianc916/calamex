import { openUrl } from '@tauri-apps/plugin-opener';

const openWithWindow = (url: string): void => {
  window.open(url, '_blank', 'noopener,noreferrer');
};

export const openExternalUrl = (url: string): void => {
  void openUrl(url).catch(() => {
    openWithWindow(url);
  });
};
