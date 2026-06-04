use std::time::Instant;

/// 终端快照保留的**字节**上限（不是字符数）。160 KiB。
pub const TERMINAL_SNAPSHOT_MAX_LENGTH: usize = 160 * 1024;

#[derive(Clone, Copy, Default)]
pub struct TerminalInteractiveVisualState {
    pub resize_repaint_suppress_until: Option<Instant>,
    pub alt_screen_active: bool,
}

/// 将快照裁剪到 [`TERMINAL_SNAPSHOT_MAX_LENGTH`] 以内。
///
/// 裁剪策略：
/// 1. 按字节裁掉头部多余部分，保留 UTF-8 字符边界。
/// 2. 进一步向前推进到下一个 `ESC` 或 `\n`，避免把新起点切在 CSI 序列中段，
///    防止下游 vt100 解析时把残片当成乱码渲染。
///    若 1 KiB 内找不到对齐点，则放弃对齐保持字节边界（避免极端情况下整段被吃掉）。
pub fn trim_terminal_snapshot(snapshot: &mut String) {
    if snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH {
        return;
    }
    let excess = snapshot.len() - TERMINAL_SNAPSHOT_MAX_LENGTH;
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

/// 扫描数据中是否存在 CSI 序列且其 final byte 落在 `final_bytes` 集合内。
///
/// final byte 是 CSI 的终止符，按 ECMA-48 落在 `0x40..=0x7E`。
/// 参数/中间字节（`0x20..=0x3F`）会被跳过。
pub fn contains_alt_screen_switch(data: &str) -> bool {
    super::vte_detect::scan_ansi_csi_events(data).alt_screen_switched
}

/// 按数据中出现顺序应用 alt-screen 私有模式，返回最终状态。
///
/// 当数据中无 alt-screen 切换事件时，直接返回 `current`；
/// 否则返回最后一条事件决定的状态。
pub fn resolve_alt_screen_state_after_data(current: bool, data: &str) -> bool {
    let events = super::vte_detect::scan_ansi_csi_events(data);
    if events.alt_screen_switched {
        events.alt_screen_active
    } else {
        current
    }
}

pub fn is_likely_interactive_resize_repaint_frame(data: &str) -> bool {
    data.contains("\x1b[H")
        && data.contains("\x1b[K")
        && (data.contains("To run a command as administrator") || data.contains("sudo <command>"))
}
