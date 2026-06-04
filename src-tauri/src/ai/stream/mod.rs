use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

const STREAM_STATE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone)]
struct StreamState {
    token: CancellationToken,
    registered_at: Instant,
}

static STREAMS: OnceLock<Mutex<HashMap<String, StreamState>>> = OnceLock::new();

fn streams() -> &'static Mutex<HashMap<String, StreamState>> {
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(stream_id: &str) {
    if stream_id.trim().is_empty() {
        return;
    }

    let mut guard = streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    prune_expired_locked(&mut guard);

    guard.insert(
        stream_id.to_string(),
        StreamState {
            token: CancellationToken::new(),
            registered_at: Instant::now(),
        },
    );
}

pub fn cancel(stream_id: &str) -> bool {
    if stream_id.trim().is_empty() {
        return false;
    }

    let mut guard = streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    prune_expired_locked(&mut guard);

    let Some(state) = guard.get(stream_id) else {
        return false;
    };

    if state.token.is_cancelled() {
        return false;
    }

    state.token.cancel();

    true
}

pub fn is_cancelled(stream_id: &str) -> bool {
    if stream_id.trim().is_empty() {
        return false;
    }

    let mut guard = streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    prune_expired_locked(&mut guard);

    guard
        .get(stream_id)
        .map(|state| state.token.is_cancelled())
        .unwrap_or(false)
}

/// 返回该 stream 的取消令牌克隆，供流式读取路径用 `select!` 等待取消信号。
/// CancellationToken 克隆共享同一取消状态：`cancel()` 触发后，所有克隆体的
/// `cancelled()` future 都会被唤醒。未注册（或已 `finish`）时返回 `None`，
/// 调用方据此视为“无取消语义”，行为与改造前保持一致。
pub fn token(stream_id: &str) -> Option<CancellationToken> {
    if stream_id.trim().is_empty() {
        return None;
    }

    let mut guard = streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    prune_expired_locked(&mut guard);

    guard.get(stream_id).map(|state| state.token.clone())
}

pub fn finish(stream_id: &str) {
    if stream_id.trim().is_empty() {
        return;
    }

    let mut guard = streams()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    guard.remove(stream_id);

    prune_expired_locked(&mut guard);
}

fn prune_expired_locked(streams: &mut HashMap<String, StreamState>) {
    let now = Instant::now();

    streams.retain(|_, state| now.duration_since(state.registered_at) <= STREAM_STATE_TTL);
}

#[cfg(test)]
mod tests {
    use super::{cancel, finish, is_cancelled, register, token};

    #[test]
    fn registered_stream_is_not_cancelled_by_default() {
        let stream_id = "test-stream-default";

        register(stream_id);

        assert!(!is_cancelled(stream_id));

        finish(stream_id);
    }

    #[test]
    fn cancel_marks_registered_stream_as_cancelled() {
        let stream_id = "test-stream-cancel";

        register(stream_id);

        assert!(cancel(stream_id));
        assert!(is_cancelled(stream_id));

        finish(stream_id);
    }

    #[test]
    fn cancelling_same_stream_twice_returns_false_second_time() {
        let stream_id = "test-stream-double-cancel";

        register(stream_id);

        assert!(cancel(stream_id));
        assert!(!cancel(stream_id));
        assert!(is_cancelled(stream_id));

        finish(stream_id);
    }

    #[test]
    fn finish_removes_stream_state() {
        let stream_id = "test-stream-finish";

        register(stream_id);
        assert!(cancel(stream_id));
        assert!(is_cancelled(stream_id));

        finish(stream_id);

        assert!(!is_cancelled(stream_id));
    }

    #[test]
    fn cancel_unknown_stream_returns_false() {
        let stream_id = "test-stream-unknown";

        finish(stream_id);

        assert!(!cancel(stream_id));
        assert!(!is_cancelled(stream_id));
    }

    #[test]
    fn register_resets_previous_cancelled_state() {
        let stream_id = "test-stream-register-reset";

        register(stream_id);
        assert!(cancel(stream_id));
        assert!(is_cancelled(stream_id));

        register(stream_id);

        assert!(!is_cancelled(stream_id));

        finish(stream_id);
    }

    #[test]
    fn empty_stream_id_is_ignored() {
        register("");
        assert!(!cancel(""));
        assert!(!is_cancelled(""));
        finish("");
    }

    #[test]
    fn token_tracks_cancellation_and_clears_after_finish() {
        let stream_id = "test-stream-token";

        register(stream_id);

        let handle = token(stream_id).expect("token should exist after register");
        assert!(!handle.is_cancelled());

        assert!(cancel(stream_id));
        assert!(handle.is_cancelled());

        finish(stream_id);

        assert!(token(stream_id).is_none());
    }

    #[test]
    fn token_for_unknown_or_empty_stream_is_none() {
        assert!(token("").is_none());
        assert!(token("test-stream-token-unknown").is_none());
    }
}
