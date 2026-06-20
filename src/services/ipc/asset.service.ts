import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * 将本地文件系统路径转换为 webview 可直接加载的 asset:// URL。
 *
 * 纯同步 URL 改写（非 IPC），但仍归口 services 层，以统一收敛对
 * '@tauri-apps/*' 的直接依赖，保持“前端 I/O 只走 services”约束零例外。
 */
export const toAssetUrl = (path: string): string => convertFileSrc(path);
