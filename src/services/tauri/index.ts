import type { ITauriService } from '@/types/tauri';
import { aiTauriService } from './ai';
import { aiEditTauriService } from './ai-edit';
import { gitTauriService } from './git';
import { sidecarTauriService } from './sidecar';
import { sshTauriService } from './ssh';
import { terminalTauriService } from './terminal';
import { workspaceTauriService } from './workspace';

export type { IIpcCallOptions, TIpcAuditLevel } from './core/ipc-types';

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
