import { desktopRuntimeReady } from '@/utils/platform/desktop-runtime';

/**
 * 窗口 chrome（最小化 / 最大化 / 原生状态变化监听）唯一的
 * @tauri-apps/api/window 出口。
 *
 * - 标题栏拖拽区域已改用声明式 `data-tauri-drag-region`（见 AppShellLayout.vue
 *   模板），不经过本服务；这里只封装拖拽区域做不到的部分。
 * - `@tauri-apps/api/window` 的动态 import 结果做进程内缓存：此前
 *   AppShellLayout.vue 内部每次调用都重新 `await import(...)`，同一个模块被
 *   反复解析。缓存后只解析一次。
 * - 浏览器预览模式（非桌面运行时）下全部方法安全地解析为 no-op / 空实现，
 *   调用方无需重复判断运行时；运行时判断统一委托给 desktopRuntimeReady，
 *   不再各处各写一份 `__TAURI_INTERNALS__` 探测逻辑。
 */

type TAppWindowModule = typeof import('@tauri-apps/api/window');
type TAppWindow = ReturnType<TAppWindowModule['getCurrentWindow']>;

let cachedWindowModule: Promise<TAppWindowModule> | null = null;

const loadAppWindowModule = (): Promise<TAppWindowModule> => {
  cachedWindowModule ??= import('@tauri-apps/api/window');
  return cachedWindowModule;
};

const getMainWindow = async (): Promise<TAppWindow | null> => {
  if (!desktopRuntimeReady.value) {
    return null;
  }

  const { getCurrentWindow } = await loadAppWindowModule();
  return getCurrentWindow();
};

export const windowChromeService = {
  /** 读取当前主窗口是否处于最大化状态；非桌面运行时固定返回 false。 */
  isMaximized: async (): Promise<boolean> => {
    const appWindow = await getMainWindow();
    if (!appWindow) {
      return false;
    }
    return appWindow.isMaximized();
  },

  /** 最小化主窗口；非桌面运行时为 no-op。 */
  minimize: async (): Promise<void> => {
    const appWindow = await getMainWindow();
    await appWindow?.minimize();
  },

  /** 在最大化/还原之间切换；非桌面运行时为 no-op。 */
  toggleMaximize: async (): Promise<void> => {
    const appWindow = await getMainWindow();
    await appWindow?.toggleMaximize();
  },

  /**
   * 监听原生窗口尺寸变化（含 OS 贴边吸附、双击标题栏最大化等非按钮触发的场景）。
   * 非桌面运行时立即返回 null，调用方应据此判断是否需要注册清理。
   */
  onResized: async (handler: () => void): Promise<(() => void) | null> => {
    const appWindow = await getMainWindow();
    if (!appWindow) {
      return null;
    }
    return appWindow.onResized(handler);
  },
};
