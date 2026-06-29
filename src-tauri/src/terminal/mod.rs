// 终端域模块：iPTY 长寿命交互会话 + 本地 WSL 脚本运行通道。

pub mod command_contracts;
pub mod dispatch;
pub mod flow_control;
pub mod local_wsl_protocol;
pub mod shell_integration;
pub mod snapshot;
pub mod state_machine;
pub mod tauri_events;
pub mod types;
pub mod utf8_decoder;
pub mod vte_detect;
pub mod wsl;
pub mod wsl_pty;

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
