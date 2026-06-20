import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * 通过系统默认应用打开外部 URL（封装 Tauri opener 插件）。
 *
 * 仅做透传，错误向上抛出；由调用方决定降级策略（如回退到 window.open）。
 */
export const openExternalUrlViaSystem = (url: string): Promise<void> => openUrl(url);
