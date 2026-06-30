import { commands } from '@/bindings/tauri';
import { type ICommandMeta, runCommand } from '@/services/tauri/core/ipc-define';
import { loadTauriEvent } from '@/services/tauri/core/ipc-runtime';
import { useEditorStore } from '@/store/editor';
import { logger } from '@/utils/platform/logger';

/**
 * 启动 / 关联文件打开服务（push + pull 双通道，确定性，无定时重发）。
 *
 * - push：实例已运行时，二次启动（双击关联文件）经 Rust 单实例插件把路径作为
 *   calamex://open-file 实时事件推送，这里订阅后即时打开。
 * - pull：冷启动时关联文件在 argv 中，但本监听器要等 Vue 挂载后才注册，存在竞态。Rust 端把
 *   冷启动待打开文件入队，这里在订阅完成后调用 drainPendingOpenFiles 主动拉取队列，取代旧的
 *   「[1500ms, 2500ms] 定时重发猜时序」。
 *
 * 去重：仅对「同一路径的并发在途加载」去重（cold-start drain 与 live 事件可能同时命中同一
 * 路径），加载结算后即移除——不做进程级永久去重，从而保留「再次双击已打开文件时重新聚焦其
 * 标签」的预期（openDocumentTab 本身按路径幂等复用并聚焦）。
 */

const OPEN_FILE_EVENT = 'calamex://open-file';

const launchLogger = logger.child({ scope: 'launch-open' });

const LAUNCH_OPEN_COMMAND_META = {
  loadScript: {
    command: 'load_script',
    guardHint: 'open launch file',
    idempotent: true,
    audit: 'info',
  },
  drainPendingOpenFiles: {
    command: 'drain_pending_open_files',
    guardHint: 'drain pending launch files',
    idempotent: true,
    timeoutMs: 1_000,
    audit: 'info',
  },
} satisfies Record<string, ICommandMeta>;

/** 当前正在加载的路径集合：仅用于并发去重，加载结算后移除（非永久）。 */
const inFlightPaths = new Set<string>();

async function openScriptByPath(path: string): Promise<void> {
  if (!path || inFlightPaths.has(path)) {
    return;
  }
  inFlightPaths.add(path);
  try {
    // workspaceRootPath 传 null：跳过工作区边界校验，按绝对路径直接打开关联文件。
    const payload = await runCommand(
      LAUNCH_OPEN_COMMAND_META.loadScript,
      { path },
      undefined,
      async () => commands.loadScript(path, null),
    );
    // openDocumentTab 按路径幂等：已打开则复用并聚焦，未打开则新建标签。
    useEditorStore().openDocumentTab(payload);
  } catch (error) {
    launchLogger.warn({ event: 'launch-open.load-failed', path, err: error });
  } finally {
    inFlightPaths.delete(path);
  }
}

const drainPendingOpenFiles = (): Promise<string[]> =>
  runCommand(LAUNCH_OPEN_COMMAND_META.drainPendingOpenFiles, {}, undefined, async () =>
    commands.drainPendingOpenFiles(),
  );

export async function installLaunchFileOpener(): Promise<void> {
  try {
    // 先订阅实时事件，再 drain 队列：避免「drain 与订阅之间」窗口内到达的事件丢失。
    const { listen } = await loadTauriEvent();
    await listen<string>(OPEN_FILE_EVENT, (event) => {
      void openScriptByPath(event.payload);
    });

    const pendingPaths = await drainPendingOpenFiles();
    for (const path of pendingPaths) {
      void openScriptByPath(path);
    }
  } catch (error) {
    launchLogger.warn({ event: 'launch-open.install-failed', err: error });
  }
}
