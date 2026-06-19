//! 终端域：输出流控（ack 背压）。
//!
//! 对照 VSCode `src/vs/platform/terminal/node/terminalProcess.ts` 的 `FlowControlConstants`
//! 与 `_unacknowledgedCharCount` 机制：pty 读侧累计「已发往前端但尚未确认消费」的字符数，
//! 超过高水位即暂停读取（让 ConPTY/管道自然回压 WSL 进程），前端每消费 `CHAR_COUNT_ACK_SIZE`
//! 个字符回一次 ack，未确认数回落到低水位以下即恢复读取。
//!
//! 与 VSCode 的差异（均在代码处注明）：
//! - VSCode 调用 `childProcess.pause()/resume()`；这里没有可暂停的 pty 抽象，改为「读线程在
//!   下一次 read 前阻塞」，效果等价——OS 管道缓冲填满后 ConPTY 自然对 WSL 侧背压。
//! - 字符计数单位取 UTF-16 码元数（`encode_utf16().count()`），与前端 JS 字符串 `.length`
//!   一致，确保两侧加减同一把尺子。
//! - 增加 `cancel()` 与防御性暂停上限，保证会话关闭 / ack 丢失时读线程不会永久卡死。

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// 高水位：未确认字符数达到该值即暂停读取。对照 VSCode FlowControlConstants.HighWatermarkChars。
pub const HIGH_WATERMARK_CHARS: usize = 100_000;
/// 低水位：暂停后，未确认字符数回落到该值以下才恢复读取（迟滞，避免抖动）。
/// 对照 VSCode FlowControlConstants.LowWatermarkChars。
pub const LOW_WATERMARK_CHARS: usize = 5_000;
/// 前端每消费这么多字符回一次 ack。对照 VSCode FlowControlConstants.CharCountAckSize。
pub const CHAR_COUNT_ACK_SIZE: usize = 5_000;

/// 防御性暂停上限：即便 ack 始终未到（前端异常 / 事件丢失），读线程被暂停累计超过该时长后
/// 也强制恢复一次，保证 EOF 可被探测、读线程不被永久饥死。正常 ack 通路下不会触发。
const MAX_PAUSE_GUARD: Duration = Duration::from_millis(5_000);
/// 单次等待片，便于周期性复检 paused/cancelled。
const WAIT_SLICE: Duration = Duration::from_millis(200);

#[derive(Debug)]
struct FlowState {
    unacked: usize,
    paused: bool,
    cancelled: bool,
}

#[derive(Debug)]
struct Inner {
    state: Mutex<FlowState>,
    cond: Condvar,
}

/// 每会话输出流控器：在 pty 读线程与「前端 ack 命令」之间共享。Clone 即共享同一计数。
#[derive(Clone, Debug)]
pub struct FlowController {
    inner: Arc<Inner>,
}

impl Default for FlowController {
    fn default() -> Self {
        Self::new()
    }
}

impl FlowController {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(FlowState {
                    unacked: 0,
                    paused: false,
                    cancelled: false,
                }),
                cond: Condvar::new(),
            }),
        }
    }

    /// 记录一段已发往前端的数据（chars 为 UTF-16 码元数）。达到高水位则进入暂停态。
    pub fn record_produced(&self, chars: usize) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        state.unacked = state.unacked.saturating_add(chars);
        if state.unacked >= HIGH_WATERMARK_CHARS {
            state.paused = true;
        }
    }

    /// 前端确认已消费 chars 个字符。回落到低水位以下则解除暂停并唤醒读线程。
    pub fn acknowledge(&self, chars: usize) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        state.unacked = state.unacked.saturating_sub(chars);
        if state.paused && state.unacked < LOW_WATERMARK_CHARS {
            state.paused = false;
            self.inner.cond.notify_all();
        }
    }

    /// 读线程在下一次 read 前调用：处于暂停态时阻塞，直至解除暂停 / 被取消 / 触发防御上限。
    pub fn wait_until_writable(&self) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        if state.cancelled || !state.paused {
            return;
        }
        let mut waited = Duration::ZERO;
        while state.paused && !state.cancelled {
            if waited >= MAX_PAUSE_GUARD {
                // 防御：ack 长时间未到，强制恢复一次，保证读线程不被永久饥死。
                state.paused = false;
                break;
            }
            let (next, timeout) = self
                .inner
                .cond
                .wait_timeout(state, WAIT_SLICE)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
            if timeout.timed_out() {
                waited = waited.saturating_add(WAIT_SLICE);
            }
        }
    }

    /// 取消流控（会话/运行关闭）：永久解除暂停并唤醒读线程，使其能继续读到 EOF。
    pub fn cancel(&self) {
        let Ok(mut state) = self.inner.state.lock() else {
            return;
        };
        state.cancelled = true;
        state.paused = false;
        self.inner.cond.notify_all();
    }

    #[cfg(test)]
    fn is_paused(&self) -> bool {
        self.inner
            .state
            .lock()
            .map(|state| state.paused)
            .unwrap_or(false)
    }

    #[cfg(test)]
    fn unacked(&self) -> usize {
        self.inner
            .state
            .lock()
            .map(|state| state.unacked)
            .unwrap_or(0)
    }
}

/// 计 UTF-16 码元数，与前端 JS 字符串 `.length` 同尺。
pub fn utf16_len(data: &str) -> usize {
    data.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_pause_below_high_watermark() {
        let fc = FlowController::new();
        fc.record_produced(HIGH_WATERMARK_CHARS - 1);
        assert!(!fc.is_paused());
        assert_eq!(fc.unacked(), HIGH_WATERMARK_CHARS - 1);
    }

    #[test]
    fn pauses_at_high_watermark() {
        let fc = FlowController::new();
        fc.record_produced(HIGH_WATERMARK_CHARS);
        assert!(fc.is_paused());
    }

    #[test]
    fn ack_keeps_pause_until_below_low_watermark() {
        let fc = FlowController::new();
        fc.record_produced(HIGH_WATERMARK_CHARS);
        assert!(fc.is_paused());
        // 回落到低水位以上：仍暂停（迟滞）。
        fc.acknowledge(HIGH_WATERMARK_CHARS - LOW_WATERMARK_CHARS - 1);
        assert_eq!(fc.unacked(), LOW_WATERMARK_CHARS + 1);
        assert!(fc.is_paused());
        // 跨过低水位：解除暂停。
        fc.acknowledge(2);
        assert!(!fc.is_paused());
    }

    #[test]
    fn ack_never_underflows() {
        let fc = FlowController::new();
        fc.record_produced(10);
        fc.acknowledge(1_000);
        assert_eq!(fc.unacked(), 0);
    }

    #[test]
    fn wait_returns_immediately_when_not_paused() {
        let fc = FlowController::new();
        let start = std::time::Instant::now();
        fc.wait_until_writable();
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn ack_resumes_blocked_reader() {
        let fc = FlowController::new();
        fc.record_produced(HIGH_WATERMARK_CHARS);
        assert!(fc.is_paused());
        let reader = fc.clone();
        let handle = std::thread::spawn(move || {
            reader.wait_until_writable();
        });
        std::thread::sleep(Duration::from_millis(50));
        // 一次跨低水位的 ack 应解除暂停并唤醒读线程。
        fc.acknowledge(HIGH_WATERMARK_CHARS);
        handle.join().expect("读线程应在 ack 后迅速返回");
        assert!(!fc.is_paused());
    }

    #[test]
    fn cancel_unblocks_waiting_reader() {
        let fc = FlowController::new();
        fc.record_produced(HIGH_WATERMARK_CHARS);
        assert!(fc.is_paused());
        let reader = fc.clone();
        let handle = std::thread::spawn(move || {
            reader.wait_until_writable();
        });
        std::thread::sleep(Duration::from_millis(50));
        fc.cancel();
        handle.join().expect("读线程应在 cancel 后迅速返回");
    }

    #[test]
    fn utf16_len_matches_js_string_length() {
        assert_eq!(utf16_len("hello"), 5);
        assert_eq!(utf16_len("caf\u{00e9}"), 4);
        // 超出 BMP 的字符（代理对）计为 2 个 UTF-16 码元，与 JS `.length` 一致。
        assert_eq!(utf16_len("\u{1f980}"), 2);
        assert_eq!(utf16_len("a\u{1f980}b"), 4);
    }
}
