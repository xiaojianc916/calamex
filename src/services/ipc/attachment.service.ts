import { invokeTauriCommand } from '@/services/tauri/core/ipc-runtime';

/**
 * 用户经原生文件对话框选中的附件读取结果。
 * base64 为文件字节的 Base64 编码，前端解码后构造浏览器 File 对象。
 */
export interface IAttachmentFilePayload {
  name: string;
  base64: string;
}

/**
 * 读取用户经原生对话框显式选中的附件文件。
 *
 * 走受限的后端命令 `read_attachment_file`（canonicalize + 拒绝符号链接 + 体积上限），
 * 取代此前前端直连 `@tauri-apps/plugin-fs` 的 `readFile`——后者依赖能力清单里的
 * `fs:allow-read-file` + `fs:scope: "**"`（全盘读），属过度授权（见地基审查 S1）。
 */
export const readAttachmentFile = (path: string): Promise<IAttachmentFilePayload> =>
  invokeTauriCommand<IAttachmentFilePayload>('read_attachment_file', { path });
