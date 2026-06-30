import { commands } from '@/bindings/tauri';
import { loadTauriEvent } from '@/services/tauri/core/ipc-runtime';
import { useEditorStore } from '@/store/editor';

const OPEN_FILE_EVENT = 'calamex://open-file';

// Rust 端冷启动会按 [1500ms, 2500ms] 重发同一路径以规避监听器注册竞态，这里按路径去重。
const openedPaths = new Set<string>();

async function openScriptByPath(path: string): Promise<void> {
  if (!path || openedPaths.has(path)) {
    return;
  }
  openedPaths.add(path);
  try {
    // tauri-specta Throw 模式：loadScript 直接返回 payload，失败抛出结构化错误。
    // workspaceRootPath 传 null：跳过工作区边界校验，按绝对路径直接打开关联文件。
    const payload = await commands.loadScript(path, null);
    useEditorStore().openDocumentTab(payload);
  } catch (error) {
    openedPaths.delete(path);
    console.warn('打开关联脚本文件失败', path, error);
  }
}

export async function installLaunchFileOpener(): Promise<void> {
  try {
    const { listen } = await loadTauriEvent();
    await listen<string>(OPEN_FILE_EVENT, (event) => {
      void openScriptByPath(event.payload);
    });
  } catch (error) {
    console.warn('安装关联文件打开监听器失败', error);
  }
}
