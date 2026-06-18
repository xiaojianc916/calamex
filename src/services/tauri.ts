import type { ITauriService } from '@/types/tauri';
import { aiTauriService } from './tauri.ai';
import { aiEditTauriService } from './tauri.ai-edit';
import { gitTauriService } from './tauri.git';
import { sidecarTauriService } from './tauri.sidecar';
import { sshTauriService } from './tauri.ssh';
import { terminalTauriService } from './tauri.terminal';
import { workspaceTauriService } from './tauri.workspace';

export type { IIpcCallOptions, TIpcAuditLevel } from './tauri.ipc-types';

/**
 * Tauri IPC 服务门面。
 *
 * 实现按领域拆分为 `tauri.<domain>.ts` 兄弟文件；此处仅负责按域聚合，
 * 对外仍以单一 `tauriService` 暴露完整 `ITauriService`，以及 `pick*` 对话框辅助方法。
 */
export const tauriService: ITauriService & {
  pickOpenPath(): Promise<string | null>;
  pickAnyOpenPath(): Promise<string | null>;
  pickOpenFolderPath(): Promise<string | null>;
  pickSavePath(defaultPath: string): Promise<string | null>;
  pickAnySavePath(defaultPath: string): Promise<string | null>;
} = {
  ...sidecarTauriService,
  ...workspaceTauriService,
  ...gitTauriService,
  ...terminalTauriService,
  ...sshTauriService,
  ...aiTauriService,
  ...aiEditTauriService,
};
