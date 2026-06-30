//! 启动 / 关联文件打开（launch-open）。
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
