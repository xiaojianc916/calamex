import { z } from 'zod';

/**
 * @deprecated Tauri invoke 契约已迁移到 tauri-specta 生成绑定（src/bindings/tauri.ts）。
 * 不得在此新增手写 Zod contract；仅保留 zTauriVoid 供尚未迁移的少量 invoke 路径
 * （如 window.service）及相关单测复用。后续 window 收口后本文件可整体移除。
 */
export const zTauriVoid = z
  .union([z.null(), z.undefined(), z.void()])
  .transform(() => undefined as void);
