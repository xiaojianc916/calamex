//! 内容搜索的流式分批推送。
//!
//! 普通（精确/正则/模糊）内容搜索在 rayon 线程池里并行扫描，每个文件的命中一旦产生
//! 就通过 `ContentBatchSink::push` 交给这里；本模块按「攒满 STREAM_BATCH_SIZE 条」或
//! 「距上次推送超过 STREAM_FLUSH_INTERVAL」节流，合并成批，用强类型 specta 事件
//! `workspace-search-stream` 推给前端，实现「边搜边出」的流水式体感。最终的全局排序结果
//! 仍由命令返回值兜底（前端在命令 resolve 后用其整体替换流式列表）。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_specta::Event as _;

use super::types::{WorkspaceSearchResult, WorkspaceSearchStreamEvent};

/// 攒满这么多条内容命中就立即推送一批。
pub(super) const STREAM_BATCH_SIZE: usize = 100;
/// 距上次推送超过这个时长就推送（即使没攒满），保证“流水”体感不被大文件拖住。
pub(super) const STREAM_FLUSH_INTERVAL: Duration = Duration::from_millis(50);

/// 内容搜索的分批推送目标。
///
/// 由 `find` 在并行扫描中按文件调用 `push`（发现顺序），由 `mod` 在内容搜索结束后调用
/// `finish` 收尾。要求 `Sync`：内容搜索在 rayon 线程池里并行 push。
pub(super) trait ContentBatchSink: Sync {
    /// 追加一个文件的命中（发现顺序）。内部按条数/时间节流，达到阈值才真正推送。
    fn push(&self, results: &[WorkspaceSearchResult]);
    /// 内容搜索结束：把缓冲区里剩余的命中推送出去。
    fn finish(&self);
}

/// 节流缓冲：纯逻辑、无 IO，便于单测。
struct StreamThrottle {
    pending: Vec<WorkspaceSearchResult>,
    last_flush: Instant,
    streamed_total: usize,
    max_total: usize,
}

impl StreamThrottle {
    fn new(max_total: usize, now: Instant) -> Self {
        Self {
            pending: Vec::new(),
            last_flush: now,
            streamed_total: 0,
            max_total,
        }
    }

    /// 追加一批命中，并按阈值/时间决定是否需要立即 flush。
    /// 返回 `Some(batch)` 表示应当把 batch 推送出去；`None` 表示继续攒。
    fn offer(
        &mut self,
        results: &[WorkspaceSearchResult],
        now: Instant,
    ) -> Option<Vec<WorkspaceSearchResult>> {
        if results.is_empty() || self.streamed_total >= self.max_total {
            return None;
        }
        // 与命令最终回传共享同一总量上限：流式阶段最多推送 max_total 条，避免极端查询下负载膨胀。
        let remaining = self.max_total - self.streamed_total;
        let take = remaining.min(results.len());
        self.streamed_total += take;
        self.pending.extend_from_slice(&results[..take]);

        if self.pending.len() >= STREAM_BATCH_SIZE
            || now.saturating_duration_since(self.last_flush) >= STREAM_FLUSH_INTERVAL
        {
            self.last_flush = now;
            Some(std::mem::take(&mut self.pending))
        } else {
            None
        }
    }

    /// 收尾：取出全部剩余命中。
    fn drain(&mut self, now: Instant) -> Vec<WorkspaceSearchResult> {
        self.last_flush = now;
        std::mem::take(&mut self.pending)
    }
}

/// 通过强类型 specta 事件 `workspace-search-stream` 把内容命中分批推给前端。
pub(super) struct SearchStreamSink<'a> {
    app: &'a AppHandle,
    search_id: u32,
    root_path: String,
    throttle: Mutex<StreamThrottle>,
}

impl<'a> SearchStreamSink<'a> {
    pub(super) fn new(
        app: &'a AppHandle,
        search_id: u32,
        root_path: String,
        max_total: usize,
    ) -> Self {
        Self {
            app,
            search_id,
            root_path,
            throttle: Mutex::new(StreamThrottle::new(max_total, Instant::now())),
        }
    }

    /// 把一批命中作为单个事件 emit 给前端（不持有 throttle 锁，减少并行 push 竞争）。
    fn emit(&self, results: Vec<WorkspaceSearchResult>) {
        if results.is_empty() {
            return;
        }
        let event = WorkspaceSearchStreamEvent {
            search_id: self.search_id,
            root_path: self.root_path.clone(),
            results,
        };
        if let Err(error) = event.emit(self.app) {
            log::warn!("发送流式搜索结果失败: {error}");
        }
    }
}

impl ContentBatchSink for SearchStreamSink<'_> {
    fn push(&self, results: &[WorkspaceSearchResult]) {
        if results.is_empty() {
            return;
        }
        let batch = {
            let Ok(mut throttle) = self.throttle.lock() else {
                return;
            };
            throttle.offer(results, Instant::now())
        };
        if let Some(batch) = batch {
            self.emit(batch);
        }
    }

    fn finish(&self) {
        let batch = {
            let Ok(mut throttle) = self.throttle.lock() else {
                return;
            };
            throttle.drain(Instant::now())
        };
        self.emit(batch);
    }
}

#[cfg(test)]
mod tests {
    use super::super::types::WorkspaceSearchResultKind;
    use super::*;

    fn content_result(path: &str) -> WorkspaceSearchResult {
        WorkspaceSearchResult {
            path: path.to_string(),
            relative_path: path.to_string(),
            name: path.to_string(),
            kind: WorkspaceSearchResultKind::Content,
            line_number: Some(1),
            line_text: Some("x".to_string()),
            match_start: Some(0),
            match_end: Some(1),
            score: 1,
        }
    }

    fn batch(n: usize) -> Vec<WorkspaceSearchResult> {
        (0..n)
            .map(|i| content_result(&format!("f{i}.sh")))
            .collect()
    }

    #[test]
    fn flushes_when_batch_size_reached() {
        let start = Instant::now();
        let mut throttle = StreamThrottle::new(10_000, start);
        // 不足阈值且时间未到：继续攒。
        assert!(throttle.offer(&batch(40), start).is_none());
        // 累计达到 STREAM_BATCH_SIZE：立即吐出全部已攒。
        let flushed = throttle
            .offer(&batch(60), start)
            .expect("达到批量阈值应 flush");
        assert_eq!(flushed.len(), STREAM_BATCH_SIZE);
        assert!(throttle.pending.is_empty());
    }

    #[test]
    fn flushes_when_interval_elapsed() {
        let start = Instant::now();
        let mut throttle = StreamThrottle::new(10_000, start);
        assert!(throttle.offer(&batch(1), start).is_none());
        let later = start + STREAM_FLUSH_INTERVAL + Duration::from_millis(1);
        let flushed = throttle
            .offer(&batch(1), later)
            .expect("超过节流间隔应 flush");
        assert_eq!(flushed.len(), 2);
    }

    #[test]
    fn caps_streamed_total_at_max() {
        let start = Instant::now();
        let mut throttle = StreamThrottle::new(150, start);
        // 第一批 100 条达到批量阈值，flush 100。
        let first = throttle.offer(&batch(100), start).expect("应 flush 第一批");
        assert_eq!(first.len(), 100);
        // 再来 100 条，但总量上限 150，只接收 50；50 < 阈值且时间未到 -> 继续攒。
        assert!(throttle.offer(&batch(100), start).is_none());
        assert_eq!(throttle.streamed_total, 150);
        // 已达上限，后续不再接收。
        assert!(throttle.offer(&batch(100), start).is_none());
        // drain 取出最后攒的 50。
        let rest = throttle.drain(start);
        assert_eq!(rest.len(), 50);
    }

    #[test]
    fn drain_returns_remaining_pending() {
        let start = Instant::now();
        let mut throttle = StreamThrottle::new(10_000, start);
        assert!(throttle.offer(&batch(3), start).is_none());
        let drained = throttle.drain(start);
        assert_eq!(drained.len(), 3);
        assert!(throttle.drain(start).is_empty());
    }
}
