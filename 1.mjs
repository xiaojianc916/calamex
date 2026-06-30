// 3.mjs —— 关联文件打开：改为 push + pull 专业架构（EOL 安全 / 幂等）
// 运行：在仓库根目录执行  node 3.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = process.cwd();
const p = (rel) => join(ROOT, rel);
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');
const restore = (s, eol) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);

let hadError = false;
const say = (m) => console.log(m);

// 对已存在文件做一组锚点编辑（全部成功或全部跳过才写盘）。
function patchFile(rel, edits) {
  const abs = p(rel);
  if (!existsSync(abs)) {
    hadError = true;
    say(`✗ 找不到文件：${rel}`);
    return;
  }
  const raw = readFileSync(abs, 'utf8');
  const eol = detectEol(raw);
  let content = toLf(raw);
  let changed = false;
  let failed = false;
  const logs = [];

  for (const e of edits) {
    if (content.includes(e.marker)) {
      logs.push(`  • 跳过（已应用）：${e.label}`);
      continue;
    }
    if (e.remove !== undefined) {
      if (!content.includes(e.remove)) {
        logs.push(`  ✗ 未找到锚点：${e.label}`);
        failed = true;
        continue;
      }
      content = content.replace(e.remove, e.insert ?? '');
      changed = true;
      logs.push(`  ✓ ${e.label}`);
      continue;
    }
    if (!content.includes(e.find)) {
      logs.push(`  ✗ 未找到锚点：${e.label}`);
      failed = true;
      continue;
    }
    content = content.replace(e.find, e.replace);
    changed = true;
    logs.push(`  ✓ ${e.label}`);
  }

  say(`\n${rel}`);
  logs.forEach((l) => say(l));

  if (failed) {
    hadError = true;
    say(`  → 因有锚点缺失，未写入 ${rel}（请核对该文件是否为最新版本）`);
    return;
  }
  if (!changed) {
    say(`  → 无需改动`);
    return;
  }
  writeFileSync(abs, restore(content, eol), 'utf8');
  say(`  → 已写入`);
}

// 整文件写入（新建或覆盖），EOL 跟随参考文件。
function writeWhole(rel, body, eolRef) {
  const abs = p(rel);
  let eol = '\n';
  if (eolRef && existsSync(p(eolRef))) eol = detectEol(readFileSync(p(eolRef), 'utf8'));
  else if (existsSync(abs)) eol = detectEol(readFileSync(abs, 'utf8'));
  mkdirSync(dirname(abs), { recursive: true });
  const next = restore(toLf(body), eol);
  if (existsSync(abs) && readFileSync(abs, 'utf8') === next) {
    say(`\n${rel}\n  → 无需改动`);
    return;
  }
  writeFileSync(abs, next, 'utf8');
  say(`\n${rel}\n  → 已写入`);
}

// ---------------------------------------------------------------------------
// 1) 新增 src-tauri/src/launch.rs
// ---------------------------------------------------------------------------
const LAUNCH_RS = `//! 启动 / 关联文件打开（launch-open）。
//!
//! 把「双击 .sh/.bash 关联文件 / 命令行带文件参数启动」统一收敛到本模块，避免散落在 main.rs：
//! - 冷启动（进程首次启动）：关联文件在 argv 中，但前端事件监听器要等 Vue 挂载后才注册，存在
//!   竞态。这里把待打开文件入队（PendingOpenFiles），前端就绪后经 drain_pending_open_files
//!   主动拉取（pull），取代旧的「按 [1500ms, 2500ms] 定时重发猜时序」——确定性、零重复。
//! - 二次启动（已有实例运行）：单实例插件把新进程 argv 回流，这里作为实时事件推送（push）。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// 前端监听以打开关联文件的事件名（payload 为文件绝对路径）。跨 IPC 边界的协议常量，
/// 前端 launch-open.service.ts 中有一份同名副本。
pub const OPEN_FILE_EVENT: &str = "calamex://open-file";

/// 冷启动待打开文件队列（进程级托管状态）。
///
/// 仅在启动早期入队、前端就绪后一次性 drain，容量极小，用 Mutex<Vec<String>> 足够。
#[derive(Default)]
pub struct PendingOpenFiles(Mutex<Vec<String>>);

impl PendingOpenFiles {
    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<String>> {
        // 临界区内无 panic 点；万一被毒化也降级取回数据，绝不让启动路径因一个尽力而为的
        // 打开队列而 panic。
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn push_many(&self, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        self.lock().extend(paths);
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.lock())
    }
}

/// 从进程启动参数中提取可打开的脚本路径（关联文件双击 / 命令行传入）。
/// 跳过 argv[0]（程序自身）与以 - 开头的选项，仅保留确实存在的 .sh/.bash 文件。
pub fn extract_openable_files(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| {
            let path = std::path::Path::new(arg.as_str());
            let is_shell = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("sh") || ext.eq_ignore_ascii_case("bash"))
                .unwrap_or(false);
            is_shell && path.is_file()
        })
        .cloned()
        .collect()
}

/// 冷启动：把启动参数里的待打开文件入队，等前端 drain（pull）。无文件参数时为空操作。
pub fn queue_pending_open_files<R: Runtime>(app_handle: &AppHandle<R>, argv: &[String]) {
    let files = extract_openable_files(argv);
    if files.is_empty() {
        return;
    }
    app_handle.state::<PendingOpenFiles>().push_many(files);
}

/// 二次启动：实例已运行、前端监听器已就绪，直接把待打开文件作为实时事件推送（push）。
pub fn emit_open_files<R: Runtime>(app_handle: &AppHandle<R>, argv: &[String]) {
    for path in extract_openable_files(argv) {
        if let Err(error) = app_handle.emit(OPEN_FILE_EVENT, path.clone()) {
            tracing::warn!("failed to emit open-file event for {path}: {error}");
        }
    }
}

/// 前端就绪后主动拉取冷启动待打开文件（pull）；返回后队列清空，重复调用安全（幂等）。
#[tauri::command]
#[specta::specta]
pub fn drain_pending_open_files(state: State<'_, PendingOpenFiles>) -> Vec<String> {
    state.take()
}
`;

// ---------------------------------------------------------------------------
// 2) src/services/ipc/launch-open.service.ts（整文件重写）
// ---------------------------------------------------------------------------
const SERVICE_TS = `import { commands } from '@/bindings/tauri';
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
  runCommand(
    LAUNCH_OPEN_COMMAND_META.drainPendingOpenFiles,
    {},
    undefined,
    async () => commands.drainPendingOpenFiles(),
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
`;

// ---------------------------------------------------------------------------
// 3) main.rs 锚点编辑
// ---------------------------------------------------------------------------
const MAIN_INLINE_BLOCK = `const OPEN_FILE_EVENT: &str = "calamex://open-file";

/// 从进程启动参数中提取可打开的脚本路径（关联文件双击 / 命令行传入）。
/// 跳过 argv[0]（程序自身）与以 - 开头的选项，仅保留确实存在的 .sh/.bash 文件。
fn extract_openable_files(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| {
            let path = std::path::Path::new(arg.as_str());
            let is_shell = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("sh") || ext.eq_ignore_ascii_case("bash"))
                .unwrap_or(false);
            is_shell && path.is_file()
        })
        .cloned()
        .collect()
}

/// 把启动参数里的待打开文件逐个发往前端（事件名 calamex://open-file，payload 为绝对路径）。
fn emit_open_files<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>, argv: &[String]) {
    for path in extract_openable_files(argv) {
        if let Err(error) = app_handle.emit(OPEN_FILE_EVENT, path.clone()) {
            tracing::warn!("failed to emit open-file event for {path}: {error}");
        }
    }
}`;

const MAIN_INLINE_COMMENT =
  `// 关联文件打开（冷启动入队 + 二次启动实时事件）的逻辑统一收敛到 launch 模块。`;

const MAIN_COLDSTART_BLOCK = `            // 冷启动关联文件打开：进程首次启动（非二次实例）时，关联文件路径在 argv 中。
            // 前端事件监听器要等 Vue 挂载后才注册，存在竞态——此处延迟后按 [1500ms, 2500ms]
            // 重发，由前端按路径去重，确保「冷启动双击 .sh」必定打开对应文件。
            {
                let open_files_app = app.handle().clone();
                std::thread::spawn(move || {
                    let argv: Vec<String> = std::env::args().collect();
                    if extract_openable_files(&argv).is_empty() {
                        return;
                    }
                    for delay_ms in [1500_u64, 2500_u64] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        emit_open_files(&open_files_app, &argv);
                    }
                });
            }`;

const MAIN_COLDSTART_REPLACE = `            // 冷启动关联文件打开：进程首次启动（非二次实例）时，关联文件路径在 argv 中。
            // 前端监听器要等 Vue 挂载后才注册，存在竞态——此处不再「定时重发猜时序」，而是把待
            // 打开文件入队，由前端就绪后经 drain_pending_open_files 主动拉取（pull），确保
            // 「冷启动双击 .sh」必定打开且只打开一次。
            {
                let argv: Vec<String> = std::env::args().collect();
                launch::queue_pending_open_files(app.handle(), &argv);
            }`;

patchFile('src-tauri/src/main.rs', [
  {
    label: '声明 mod launch;',
    marker: 'mod launch;',
    find: 'mod lifecycle;',
    replace: 'mod lifecycle;\nmod launch;',
  },
  {
    label: '移除已不再使用的 Emitter 导入',
    marker: '    Manager, WindowEvent,\n    menu::',
    find: '    Emitter, Manager, WindowEvent,',
    replace: '    Manager, WindowEvent,',
  },
  {
    label: '移除内联的 OPEN_FILE_EVENT / extract_openable_files / emit_open_files',
    marker: MAIN_INLINE_COMMENT,
    remove: MAIN_INLINE_BLOCK,
    insert: MAIN_INLINE_COMMENT,
  },
  {
    label: '二次启动调用改为 launch::emit_open_files',
    marker: 'launch::emit_open_files(app, &argv);',
    find: '            emit_open_files(app, &argv);',
    replace: '            launch::emit_open_files(app, &argv);',
  },
  {
    label: '冷启动改为入队（删除定时重发线程）',
    marker: 'launch::queue_pending_open_files(app.handle(), &argv);',
    remove: MAIN_COLDSTART_BLOCK,
    insert: MAIN_COLDSTART_REPLACE,
  },
  {
    label: '托管 PendingOpenFiles 状态',
    marker: 'launch::PendingOpenFiles::default()',
    find: '        .manage(AppLifecycleState::default())',
    replace:
      '        .manage(AppLifecycleState::default())\n        .manage(launch::PendingOpenFiles::default())',
  },
]);

// ---------------------------------------------------------------------------
// 4) tauri_bindings.rs 注册命令
// ---------------------------------------------------------------------------
patchFile('src-tauri/src/tauri_bindings.rs', [
  {
    label: '导入 launch 模块',
    marker: 'use crate::launch;',
    find: 'use specta_typescript::Typescript;',
    replace: 'use crate::launch;\nuse specta_typescript::Typescript;',
  },
  {
    label: '注册 drain_pending_open_files 命令',
    marker: 'launch::drain_pending_open_files,',
    find: '            lsp_commands::lsp_hover,\n        ])',
    replace:
      '            lsp_commands::lsp_hover,\n            launch::drain_pending_open_files,\n        ])',
  },
]);

// ---------------------------------------------------------------------------
// 5) src/bindings/tauri.ts 补绑定（release 构建不会自动重生成）
// ---------------------------------------------------------------------------
patchFile('src/bindings/tauri.ts', [
  {
    label: '补 drainPendingOpenFiles 绑定',
    marker: 'drainPendingOpenFiles',
    find: '\n};\n\n/** Events */',
    replace:
      '\n\tdrainPendingOpenFiles: () => __TAURI_INVOKE<string[]>("drain_pending_open_files"),\n};\n\n/** Events */',
  },
]);

// ---------------------------------------------------------------------------
// 6) 写文件
// ---------------------------------------------------------------------------
writeWhole('src-tauri/src/launch.rs', LAUNCH_RS, 'src-tauri/src/main.rs');
writeWhole('src/services/ipc/launch-open.service.ts', SERVICE_TS, 'src/services/ipc/launch-open.service.ts');

say('\n' + (hadError
  ? '⚠️ 有锚点未命中，相关文件已跳过。请确认仓库为最新 main 后重跑。'
  : '✅ 全部完成。接着跑 pnpm install && pnpm tauri:build 验证（我无法在此编译）。'));