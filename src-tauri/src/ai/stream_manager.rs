use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

static CANCELLED_STREAMS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_streams() -> &'static Mutex<HashSet<String>> {
    CANCELLED_STREAMS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn register(stream_id: &str) {
    let mut guard = cancelled_streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.remove(stream_id);
}

pub fn cancel(stream_id: &str) -> bool {
    let mut guard = cancelled_streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.insert(stream_id.to_string())
}

pub fn is_cancelled(stream_id: &str) -> bool {
    let guard = cancelled_streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.contains(stream_id)
}

pub fn finish(stream_id: &str) {
    let mut guard = cancelled_streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.remove(stream_id);
}
