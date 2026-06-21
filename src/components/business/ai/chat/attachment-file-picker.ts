// 原生附件选择：用系统文件对话框替代隐藏的 <input type="file">。
//
// 背景：HTML 文件输入受 WebView 安全限制，无法指定初始目录，默认会停在
// 进程工作目录（cwd），表现为「总是打开某个无关目录」。原生对话框支持
// defaultPath，可做到专业软件的行为：记忆上次目录、首次回退工作区根/主目录。
//
// 选路径用 @tauri-apps/plugin-dialog，读字节用 @tauri-apps/plugin-fs，二者均
// 懒加载（与 services/tauri.ipc-runtime 的懒加载约定一致），便于浏览器预览
// 环境下优雅降级（调用方捕获异常后回退到浏览器 <input type="file">）。

const ATTACHMENT_LAST_DIR_KEY = 'calamex.ai.attachment.last-dir';

// 仅用于区分「图片 vs 文本」附件（附件管线只按 file.type 是否以 image/ 开头分类）。
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

const lastSeparatorIndex = (filePath: string): number =>
  Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));

const basenameFromPath = (filePath: string): string => {
  const index = lastSeparatorIndex(filePath);
  return index >= 0 ? filePath.slice(index + 1) : filePath;
};

const dirnameFromPath = (filePath: string): string | null => {
  const index = lastSeparatorIndex(filePath);
  return index > 0 ? filePath.slice(0, index) : null;
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

const rememberDir = (filePath: string): void => {
  const dir = dirnameFromPath(filePath);
  if (!dir) {
    return;
  }
  try {
    window.localStorage.setItem(ATTACHMENT_LAST_DIR_KEY, dir);
  } catch {
    // 忽略持久化失败（如隐私模式禁用 localStorage）。
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

const readPathAsFile = async (filePath: string): Promise<File> => {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(filePath);
  const name = basenameFromPath(filePath);
  return new File([bytes], name, { type: guessMimeType(name) });
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
  rememberDir(paths[0]);
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
