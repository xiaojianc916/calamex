import {
  type AttachmentFilePayload,
  commands,
  type PickAttachmentFilesPayload,
} from '@/bindings/tauri';
import { type ICommandMeta, runCommand } from '@/services/tauri/core/ipc-define';

export type TAttachmentFilePayload = AttachmentFilePayload;
export type TPickAttachmentFilesPayload = PickAttachmentFilesPayload;

/**
 * 附件选择/读取命令的声明式包装元数据。与 agent-webview.service 同一范式。
 */
const ATTACHMENT_COMMAND_META = {
  pick: {
    command: 'pick_attachment_files',
    guardHint: '选择并读取本地附件',
    // 命令内含用户与原生文件对话框的交互，dwell 时间不可控；给足预算（前端
    // promise 超时与 native 对话框竞速，避免用户还没选完就被前端超时取消）。
    timeoutMs: 600_000,
    audit: 'sensitive',
  },
} satisfies Record<string, ICommandMeta>;

/**
 * 弹出原生文件对话框并把所选附件读回（对话框 + 读取都在 Rust 可信侧完成）。
 *
 * `defaultDir` 仅作对话框初始目录提示，不是读取目标；前端无法借此读任意文件——
 * 只有用户在原生对话框里亲手选中的文件才会被读取。取代此前前端直连
 * `@tauri-apps/plugin-fs` readFile + `fs:scope: "**"` 的全盘读授权（见地基审查 S1）。
 */
export const pickAttachmentFiles = (
  defaultDir: string | null,
): Promise<PickAttachmentFilesPayload> =>
  runCommand(ATTACHMENT_COMMAND_META.pick, { defaultDir }, undefined, () =>
    commands.pickAttachmentFiles(defaultDir),
  );
