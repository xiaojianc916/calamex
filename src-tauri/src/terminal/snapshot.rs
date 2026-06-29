use std::time::Instant;

/// 终端快照保留的**字节**上限（不是字符数）。160 KiB。
pub const TERMINAL_SNAPSHOT_MAX_LENGTH: usize = 160 * 1024;

/// 触发裁剪后回落到的低水位（上限的约 75%，120 KiB）。
///
/// 仅当快照超过 [`TERMINAL_SNAPSHOT_MAX_LENGTH`] 时才裁剪，且一次性裁到本低水位，
/// 而非每次都贴着上限裁。这样在持续输出时，裁剪只会在快照再增长约 25%（约 40 KiB）后
/// 才发生一次，把 `String::drain` 的均摊成本从 O(n)/次追加 降到 O(1)/次追加
/// （详见 docs/performance-budget.md）。
const TERMINAL_SNAPSHOT_TRIM_TARGET: usize = TERMINAL_SNAPSHOT_MAX_LENGTH * 3 / 4;

#[derive(Clone, Copy, Default)]
pub struct TerminalInteractiveVisualState {
    pub resize_repaint_suppress_until: Option<Instant>,
    pub alt_screen_active: bool,
}

/// 将快照裁剪到 [`TERMINAL_SNAPSHOT_MAX_LENGTH`] 以内。
///
/// 裁剪策略：
/// 1. 仅当超过上限时才裁剪；一次性按字节裁到低水位 [`TERMINAL_SNAPSHOT_TRIM_TARGET`]，
///    为后续追加预留约 25% 增长空间（摊还裁剪，避免每次追加都触发整段头部搬移）。
///    裁剪保留 UTF-8 字符边界。
/// 2. 进一步向前推进到下一个 `ESC` 或 `\n`，避免把新起点切在 CSI 序列中段，
///    防止下游 vt100 解析时把残片当成乱码渲染。
///    若 1 KiB 内找不到对齐点，则放弃对齐保持字节边界（避免极端情况下整段被吃掉）。
pub fn trim_terminal_snapshot(snapshot: &mut String) {
    if snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH {
        return;
    }
    // 裁到低水位（而非贴着上限），给后续追加留出约 25% 的增长空间，实现摊还化。
    let excess = snapshot.len() - TERMINAL_SNAPSHOT_TRIM_TARGET;
    let mut boundary = advance_char_boundary(snapshot, excess);

    // 对齐到下一个 ESC 或换行；最多前移 1 KiB，避免吞掉过多内容。
    const ALIGN_SEARCH_LIMIT: usize = 1024;
    let bytes = snapshot.as_bytes();
    let align_end = (boundary + ALIGN_SEARCH_LIMIT).min(bytes.len());
    if let Some(offset) = bytes[boundary..align_end]
        .iter()
        .position(|b| *b == 0x1b || *b == b'\n')
    {
        // 命中 '\n' 时跳过它，命中 ESC 时停在 ESC 上（保留完整序列）。
        let candidate = boundary + offset;
        boundary = if bytes[candidate] == b'\n' {
            advance_char_boundary(snapshot, candidate + 1)
        } else {
            candidate
        };
    }

    snapshot.drain(..boundary);
}

fn advance_char_boundary(value: &str, index: usize) -> usize {
    if index >= value.len() {
        return value.len();
    }
    let mut boundary = index;
    while boundary < value.len() && !value.is_char_boundary(boundary) {
        boundary += 1;
    }
    boundary
}


/// 整屏交互式 resize 重绘帧判定。
///
/// 旧实现用 .contains("\x1b[H") 裸字节匹配叠加英文文案启发式，依赖英文 locale，
/// 中文 Windows 或改过 UAC 文案即失效。现委托 vte_detect 用标准 VT 状态机按 CSI 指令语义
/// （光标归位 + 整屏/多行擦除）判定，与 scan_ansi_csi_events 同源，locale 无关。
pub fn is_likely_interactive_resize_repaint_frame(data: &str) -> bool {
    super::vte_detect::is_full_screen_repaint_frame(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_is_noop_under_cap() {
        let mut snapshot = "a".repeat(TERMINAL_SNAPSHOT_MAX_LENGTH);
        let before = snapshot.clone();
        trim_terminal_snapshot(&mut snapshot);
        assert_eq!(snapshot, before, "未超过上限不应裁剪");
    }

    #[test]
    fn trim_drops_to_low_water_mark() {
        // 全 ASCII、无 ESC/换行：裁剪应精确回落到低水位，而非贴着上限。
        let mut snapshot = "a".repeat(TERMINAL_SNAPSHOT_MAX_LENGTH + 1024);
        trim_terminal_snapshot(&mut snapshot);
        assert_eq!(
            snapshot.len(),
            TERMINAL_SNAPSHOT_TRIM_TARGET,
            "应一次性裁到低水位，为后续追加留出空间"
        );
        assert!(snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH);
    }

    #[test]
    fn trim_preserves_utf8_char_boundary() {
        // 多字节字符（每个 3 字节）：裁剪点必须落在字符边界，结果仍是合法 UTF-8。
        let mut snapshot = "你".repeat(TERMINAL_SNAPSHOT_MAX_LENGTH);
        trim_terminal_snapshot(&mut snapshot);
        assert!(snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH);
        // 低水位附近（最多多保留 2 字节用于对齐到字符边界）。
        assert!(snapshot.len() <= TERMINAL_SNAPSHOT_TRIM_TARGET + 2);
        assert!(
            snapshot.chars().all(|c| c == '你'),
            "裁剪不得在多字节字符中间切断"
        );
    }

    #[test]
    fn trim_aligns_to_newline_after_byte_cut() {
        // 构造让“按字节裁剪点”落在第一段 'a' 中、其后 <1KiB 处有换行：
        // 裁剪应对齐到换行之后，头部 'a' 与换行一并裁掉，只剩 'b'。
        let tail_len = TERMINAL_SNAPSHOT_TRIM_TARGET - 512;
        let head_len = TERMINAL_SNAPSHOT_MAX_LENGTH - tail_len;
        let mut snapshot = String::new();
        snapshot.push_str(&"a".repeat(head_len));
        snapshot.push('\n');
        snapshot.push_str(&"b".repeat(tail_len));
        assert!(snapshot.len() > TERMINAL_SNAPSHOT_MAX_LENGTH);
        trim_terminal_snapshot(&mut snapshot);
        assert!(snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH);
        assert!(
            snapshot.bytes().all(|b| b == b'b'),
            "应对齐到换行之后：头部 'a' 与换行都被裁掉，只剩 'b'"
        );
        assert_eq!(snapshot.len(), tail_len);
    }

    #[test]
    fn repeated_appends_stay_bounded() {
        // 模拟真实追加循环：持续追加远超上限的总量，快照长度必须始终不超过上限。
        let mut snapshot = String::new();
        let chunk = "x".repeat(4096);
        for _ in 0..1000 {
            snapshot.push_str(&chunk);
            trim_terminal_snapshot(&mut snapshot);
            assert!(
                snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH,
                "快照长度必须始终不超过上限"
            );
        }
    }
}
