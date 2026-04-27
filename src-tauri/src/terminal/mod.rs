// 终端域模块：iPTY 长寿命交互会话 + rPTY per-run 运行会话。
// 部分契约类型预留给后续命令拆分与观测闭环，当前由命令层桥接生产路径。
#![allow(dead_code)]

pub mod ansi;
pub mod command_contracts;
pub mod dispatch;
pub mod event_bus;
pub mod interactive_pty;
pub mod multiplexer;
pub mod prompt;
pub mod pty;
pub mod registry;
pub mod run_supervisor;
pub mod snapshot;
pub mod state_machine;
pub mod tauri_events;
pub mod types;
pub mod utf8_decoder;
pub mod visual;
pub mod wsl;

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    pub(crate) fn wsl_test_guard() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
