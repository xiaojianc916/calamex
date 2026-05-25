use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

// --- ANSI reset 序列 ---------------------------------------------------------
//
// 顺序约束（重要）：
// 1. 若处于 alt screen，必须**先**退出（否则后续 SGR / mode reset 落到 alt buffer 上）。
// 2. 再做安全 reset：光标可见、自动换行、SGR 清零、关闭所有鼠标跟踪。
// 3. 若动过 scroll region，最后通过 DECSC/DECSTBM-reset/DECRC 三段式把 scroll
//    region 恢复成 0..rows 同时**保留光标位置**（避免可见跳变）。

pub(crate) const TERMINAL_ANSI_SAFE_RESET: &str =
    "\x1b[?25h\x1b[?7h\x1b[m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
pub(crate) const TERMINAL_ANSI_EXIT_ALT_SCREEN: &str = "\x1b[?1049l";
pub(crate) const TERMINAL_ANSI_RESET_SCROLL_REGION_PRESERVE_CURSOR: &str = "\x1b7\x1b[r\x1b8";

/// prompt 提取的字符上限（**字符数**，不是字节数；中文/emoji 目录友好）。
const TERMINAL_PROMPT_MAX_CHARS: usize = 240;

// --- visual tracker ----------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct TerminalRunVisualTracker {
    pub(crate) has_output: bool,
    pub(crate) ended_at_line_start: bool,
    pub(crate) next_seq: u64,
    pub(crate) alt_screen_active: bool,
    pub(crate) scroll_region_changed: bool,
}

impl Default for TerminalRunVisualTracker {
    fn default() -> Self {
        Self {
            has_output: false,
            ended_at_line_start: false,
            next_seq: 1,
            alt_screen_active: false,
            scroll_region_changed: false,
        }
    }
}

impl TerminalRunVisualTracker {
    fn allocate_seq(&mut self) -> u64 {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        seq
    }

    pub(crate) fn observe(&mut self, data: &str) {
        if data.is_empty() {
            return;
        }
        self.scan_csi_events(data);
        self.has_output = true;
        self.ended_at_line_start = data.ends_with('\n') || data.ends_with('\r');
    }

    /// 单趟字节扫描，同时识别：
    /// - **alt-screen 切换**：`CSI ? {47,1047,1049} {h,l}`
    /// - **scroll region 变更**：`CSI [无 ? 前缀] ... r`（DECSTBM）
    ///
    /// ESC (0x1B) 在 UTF-8 中不会作为多字节字符的内部字节出现，故纯字节扫描是安全的。
    /// 取代了原先 `vt100::Parser::new(24, 80, 0)` 的每次分配 + 全 VT 解析。
    fn scan_csi_events(&mut self, data: &str) {
        let bytes = data.as_bytes();
        let mut i = 0;
        while i + 1 < bytes.len() {
            if bytes[i] != 0x1b || bytes[i + 1] != b'[' {
                i += 1;
                continue;
            }
            let mut cursor = i + 2;
            let private = cursor < bytes.len() && bytes[cursor] == b'?';
            if private {
                cursor += 1;
            }
            let param_start = cursor;
            // 参数字节 0x30..=0x3F + 中间字节 0x20..=0x2F
            while cursor < bytes.len() && (0x20..=0x3F).contains(&bytes[cursor]) {
                cursor += 1;
            }
            if cursor >= bytes.len() {
                break;
            }
            let final_byte = bytes[cursor];
            if !(0x40..=0x7e).contains(&final_byte) {
                // 不是合法 CSI final，跳过这个 ESC，从下一字节重新匹配
                i = cursor + 1;
                continue;
            }
            let params = &bytes[param_start..cursor];

            if private && (final_byte == b'h' || final_byte == b'l') {
                if matches!(params, b"47" | b"1047" | b"1049") {
                    self.alt_screen_active = final_byte == b'h';
                }
            } else if !private && final_byte == b'r' {
                // DECSTBM；显式排除私有模式 reset (`CSI ? Ps r`)
                self.scroll_region_changed = true;
            }
            i = cursor + 1;
        }
    }
}

// --- observation API ---------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct TerminalRunVisualObservation {
    pub prefix: &'static str,
    pub run_seq: u64,
}

/// lock poisoning sentinel：调用方可据此识别 seq 异常路径。
pub const VISUAL_RUN_SEQ_LOCK_FAILED: u64 = u64::MAX;

pub fn observe_visual_output_and_prefix(
    tracker: &Arc<Mutex<TerminalRunVisualTracker>>,
    data: &str,
) -> TerminalRunVisualObservation {
    match tracker.lock() {
        Ok(mut tracker) => {
            let prefix = if !tracker.has_output && !data.starts_with(['\r', '\n']) {
                "\r\n"
            } else {
                ""
            };
            let run_seq = tracker.allocate_seq();
            tracker.observe(data);
            TerminalRunVisualObservation { prefix, run_seq }
        }
        Err(err) => {
            // Lock poisoning 是 invariant 破坏，理论上不应发生。记录日志后返回 sentinel。
            log::error!(
                "TerminalRunVisualTracker mutex poisoned in observe_visual_output_and_prefix: {err}"
            );
            TerminalRunVisualObservation {
                prefix: "",
                run_seq: VISUAL_RUN_SEQ_LOCK_FAILED,
            }
        }
    }
}

pub fn current_visual_tracker(
    tracker: &Arc<Mutex<TerminalRunVisualTracker>>,
) -> TerminalRunVisualTracker {
    match tracker.lock() {
        Ok(guard) => *guard,
        Err(err) => {
            log::error!(
                "TerminalRunVisualTracker mutex poisoned in current_visual_tracker: {err}"
            );
            TerminalRunVisualTracker::default()
        }
    }
}

pub fn next_visual_run_seq(tracker: &Arc<Mutex<TerminalRunVisualTracker>>) -> u64 {
    match tracker.lock() {
        Ok(mut guard) => guard.allocate_seq(),
        Err(err) => {
            log::error!(
                "TerminalRunVisualTracker mutex poisoned in next_visual_run_seq: {err}"
            );
            VISUAL_RUN_SEQ_LOCK_FAILED
        }
    }
}

// --- reset & separator -------------------------------------------------------

pub fn build_terminal_ansi_reset(tracker: TerminalRunVisualTracker) -> String {
    // 预估容量：alt-screen exit (6) + safe reset (~50) + scroll restore (7) ≈ 64
    let mut reset = String::with_capacity(64);
    if tracker.alt_screen_active {
        reset.push_str(TERMINAL_ANSI_EXIT_ALT_SCREEN);
    }
    reset.push_str(TERMINAL_ANSI_SAFE_RESET);
    if tracker.scroll_region_changed {
        reset.push_str(TERMINAL_ANSI_RESET_SCROLL_REGION_PRESERVE_CURSOR);
    }
    reset
}

pub fn build_terminal_run_separator(
    visual_seq: u64,
    exit_code: Option<i32>,
    duration: Duration,
    tracker: TerminalRunVisualTracker,
    prompt: Option<String>,
) -> String {
    let prefix = if tracker.has_output && tracker.ended_at_line_start {
        ""
    } else {
        "\r\n"
    };
    let exit_label = match exit_code {
        Some(code) => format!("exit {code}"),
        None => "exit ?".to_string(),
    };
    let duration_secs = duration.as_secs_f64();
    let mut text = format!(
        "{prefix}──── run #{visual_seq} · {exit_label} · {duration_secs:.1}s ────\r\n"
    );
    if let Some(prompt) = prompt {
        text.push_str(&prompt);
    }
    text
}

// --- prompt extraction -------------------------------------------------------

/// 从终端快照尾部提取一行 shell prompt（best-effort）。
///
/// 局限性（**有意保留**）：
/// - 仅识别 `$` / `#` 作为 prompt 终止标记；PowerShell `>`、fish/zsh 主题 `❯` 等
///   不会命中，可按需扩展候选集。
/// - SGR/OSC 序列复杂时（如 zsh prompt-themes、starship）截断点可能不精确。
/// - 上限按**字符数**判断（避免中文/emoji 目录被字节比较误伤）。
pub fn extract_prompt_from_terminal_snapshot(snapshot: &str) -> Option<String> {
    if snapshot.is_empty() {
        return None;
    }

    let marker_index = snapshot
        .char_indices()
        .rev()
        .find_map(|(index, ch)| matches!(ch, '$' | '#').then_some(index))?;

    let prefix = &snapshot[..=marker_index];

    // 修正：移除了原先的 `rfind('[')` fallback —— bash ANSI 颜色码里大量包含 `[`，
    // 会把 prompt 从颜色码中段截断造成残缺。
    let start = prefix
        .rfind("\x1b[32m")
        .or_else(|| prefix.rfind("\x1b[1m"))
        .or_else(|| prefix.rfind('\n').map(|i| i + 1))
        .or_else(|| prefix.rfind('\r').map(|i| i + 1))
        .unwrap_or(0);

    let mut prompt = snapshot[start..]
        .split(['\r', '\n'])
        .next()
        .unwrap_or_default()
        .to_string();

    if prompt.chars().count() > TERMINAL_PROMPT_MAX_CHARS
        || !prompt.chars().any(|ch| matches!(ch, '$' | '#'))
    {
        return None;
    }

    if !prompt.ends_with(' ') {
        prompt.push(' ');
    }
    Some(prompt)
}