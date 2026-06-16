use std::sync::{OnceLock, RwLock};

use super::{
    event_bus::EventBus,
    types::{RunHandle, TerminalState},
};

pub struct Registry {
    pub state: RwLock<TerminalState>,
    pub active_run: RwLock<Option<RunHandle>>,
    pub event_bus: EventBus,
}

impl Registry {
    pub fn global() -> &'static Self {
        static REGISTRY: OnceLock<Registry> = OnceLock::new();
        REGISTRY.get_or_init(|| Self {
            state: RwLock::new(TerminalState::Booting),
            active_run: RwLock::new(None),
            event_bus: EventBus::default(),
        })
    }

    pub fn active_run_present(&self) -> bool {
        self.active_run
            .read()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }

    pub fn current_state(&self) -> TerminalState {
        self.state
            .read()
            .map(|guard| *guard)
            .unwrap_or(TerminalState::Booting)
    }
}

pub fn registry() -> &'static Registry {
    Registry::global()
}
