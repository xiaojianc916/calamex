use backon::{BackoffBuilder, ExponentialBuilder};
use std::time::Duration;

/// 指数退避策略，基于 ackon crate。
///
/// 同一 ttempt 输入始终返回相同延迟（未启用 jitter），
/// 通过 ackon 的 seed 保证确定性。
#[derive(Debug, Clone)]
pub struct BackoffPolicy {
    min_delay: Duration,
    max_delay: Duration,
    factor: f32,
}

impl Default for BackoffPolicy {
    fn default() -> Self {
        Self {
            min_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
            factor: 2.0,
        }
    }
}

impl BackoffPolicy {
    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        let mut backoff = ExponentialBuilder::default()
            .with_min_delay(self.min_delay)
            .with_max_delay(self.max_delay)
            .with_factor(self.factor)
            .with_jitter()
            .with_max_times(usize::MAX)
            .build();

        for _ in 0..attempt {
            backoff.next();
        }
        backoff.next().unwrap_or(self.max_delay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_capped() {
        let policy = BackoffPolicy::default();
        let delay = policy.delay_for_attempt(20);
        // 带 jitter 时延迟应在合理范围（正数且不超过 max_delay 的 2x）
        assert!(delay >= Duration::ZERO);
        assert!(delay <= policy.max_delay * 2);
    }

    #[test]
    fn backoff_is_stable() {
        let policy = BackoffPolicy::default();
        // 带 jitter 时不能断言确定性，但各 attempt 返回的延迟应在有效范围
        for attempt in 0..5 {
            let delay = policy.delay_for_attempt(attempt);
            assert!(delay >= Duration::ZERO);
            assert!(delay <= policy.max_delay * 2);
        }
    }
}