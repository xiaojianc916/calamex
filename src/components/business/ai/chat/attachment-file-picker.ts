// 原生附件选择：用系统文件对话框替代隐藏的 <input type="file">。
//
// 背景：HTML 文件输入受 WebView 安全限制，无法指定初始目录，默认会停在
// 进程工作目录（cwd），表现为「总是打开某个无关目录」。原生对话框支持
// defaultPath，可做到专业软件的行为：记忆上次目录、首次回退工作区根/主目录。
//
// 选路径走官方 @tauri-apps/plugin-dialog；路径拆解（basename/dirname）与主目录走
// @tauri-apps/api/path，均懒加载（与 services/tauri.ipc-runtime 的懒加载约定一致），
// 便于浏览器预览环境下优雅降级（调用方捕获异常后回退到浏览器 <input type="file">）。
// 读字节改走受限的后端命令 read_attachment_file（见 services/ipc/attachment.service）：
// 后端做 canonicalize + 拒绝符号链接 + 体积上限，取代此前前端直连 @tauri-apps/plugin-fs
// 的 readFile —— 后者需能力清单静态授予 fs:allow-read-file + fs:scope "**"（全盘读），
// 属过度授权（见地基审查 S1）。

import { readAttachmentFile } from '@/services/ipc/attachment.service';

const ATTACHMENT_LAST_DIR_KEY = 'calamex.ai.attachment.last-dir';

// 仅用于区分「图片 vs 文本」附件（附件管线只按 file.type 是否以 image/ 开头分类）。
// Tauri JS 侧无官方 MIME 推断能力，故保留这个极小映射；后端若需可用 mime_guess 再校正。
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

const guessMimeType = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXT[ext] ?? 'text/plain';
};

const readLastDir = (): string | null => {
  try {
    return window.localStorage.getItem(ATTACHMENT_LAST_DIR_KEY);
  } catch {
    return null;
  }
};

// 记忆本次选中文件所在目录（官方 path.dirname），供下次作为 defaultPath。
const rememberDir = async (filePath: string): Promise<void> => {
  try {
    const { dirname } = await import('@tauri-apps/api/path');
    const dir = await dirname(filePath);
    window.localStorage.setItem(ATTACHMENT_LAST_DIR_KEY, dir);
  } catch {
    // 忽略：取父目录失败（如根路径）或 localStorage 不可用（如隐私模式）。
  }
};

const resolveDefaultDir = async (
  workspaceRootPath?: string | null,
): Promise<string | undefined> => {
  const lastDir = readLastDir();
  if (lastDir) {
    return lastDir;
  }
  const workspaceRoot = workspaceRootPath?.trim();
  if (workspaceRoot) {
    return workspaceRoot;
  }
  try {
    const { homeDir } = await import('@tauri-apps/api/path');
    return await homeDir();
  } catch {
    // 取主目录失败时让对话框用系统默认目录，不阻断选择。
    return undefined;
  }
};

// Base64 → 字节：后端 read_attachment_file 以 base64 回传文件内容，这里解码为
// Uint8Array 供构造浏览器 File 对象（附件管线后续按 File 读取文本 / 图片）。
const decodeBase64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const readPathAsFile = async (filePath: string): Promise<File> => {
  const { name, base64 } = await readAttachmentFile(filePath);
  return new File([decodeBase64ToBytes(base64)], name, { type: guessMimeType(name) });
};

export interface IPickAttachmentFilesOptions {
  /** 首次（无记忆目录时）回退的工作区根目录。 */
  workspaceRootPath?: string | null;
}

/**
 * 打开原生文件对话框并把所选文件读成 File[]。
 *
 * - 返回空数组：用户取消选择或无可用文件。
 * - 抛出异常：原生运行时不可用（非桌面/浏览器预览），调用方应回退到
 *   浏览器 <input type="file">。
 */
export const pickAttachmentFilesViaNativeDialog = async (
  options: IPickAttachmentFilesOptions = {},
): Promise<File[]> => {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selection = await open({
    multiple: true,
    directory: false,
    defaultPath: await resolveDefaultDir(options.workspaceRootPath),
  });
  if (selection == null) {
    return [];
  }
  const paths = Array.isArray(selection) ? selection : [selection];
  if (paths.length === 0) {
    return [];
  }
  await rememberDir(paths[0]);
  const files: File[] = [];
  for (const filePath of paths) {
    try {
      files.push(await readPathAsFile(filePath));
    } catch {
      // 单个文件读取失败不阻断其余文件。
    }
  }
  return files;
};
