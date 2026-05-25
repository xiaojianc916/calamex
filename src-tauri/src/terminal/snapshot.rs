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
pub fn contains_csi_final(data: &str, final_bytes: &[u8]) -> bool {
    let bytes = data.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] != 0x1b || bytes[i + 1] != b'[' {
            i += 1;
            continue;
        }
        let mut cursor = i + 2;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if (0x40..=0x7e).contains(&byte) {
                if final_bytes.contains(&byte) {
                    return true;
                }
                break;
            }
            cursor += 1;
        }
        // cursor 要么停在 final byte 上（无 match），要么走到末尾（CSI 截断）。
        // 两种情况都从 cursor + 1 继续，避免重新匹配同一段 ESC[。
        i = cursor + 1;
    }
    false
}

// --- alt-screen 检测（纯字节扫描，无 vt100 依赖、零分配） -------------------

/// 扫描下一条 `CSI ? <param> <h|l>` 私有模式序列，若 param 命中 alt-screen 三件套
/// (`47` / `1047` / `1049`)，返回 (序列末尾偏移, 是否进入 alt screen)。
fn next_alt_screen_event(bytes: &[u8], start: usize) -> Option<(usize, bool)> {
    let mut i = start;
    while i + 3 < bytes.len() {
        if bytes[i] != 0x1b || bytes[i + 1] != b'[' || bytes[i + 2] != b'?' {
            i += 1;
            continue;
        }
        // 解析数字参数
        let mut j = i + 3;
        let param_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j >= bytes.len() || param_start == j {
            i += 1;
            continue;
        }
        let final_byte = bytes[j];
        if final_byte != b'h' && final_byte != b'l' {
            i = j;
            continue;
        }
        let entering = final_byte == b'h';
        // 只关心 alt-screen 三件套
        let matched = matches!(&bytes[param_start..j], b"47" | b"1047" | b"1049");
        if matched {
            return Some((j + 1, entering));
        }
        i = j + 1;
    }
    None
}

/// 检测数据中是否存在任意一次 alt-screen 切换。
///
/// 与「最终状态是否变化」不同：本函数对 `enter -> exit` round-trip 也返回 `true`，
/// 因为切换事件本身就发生了两次。
pub fn contains_alt_screen_switch(data: &str) -> bool {
    if data.is_empty() {
        return false;
    }
    next_alt_screen_event(data.as_bytes(), 0).is_some()
}

/// 按数据中出现顺序应用 alt-screen 私有模式，返回最终状态。
///
/// 比起新建 `vt100::Parser` 走完整 VT 解析，本实现零分配、单趟扫描。
/// ESC (0x1B) 在 UTF-8 中不会作为多字节字符的内部字节出现，故纯字节扫描是安全的。
pub fn resolve_alt_screen_state_after_data(current: bool, data: &str) -> bool {
    if data.is_empty() {
        return current;
    }
    let bytes = data.as_bytes();
    let mut state = current;
    let mut cursor = 0;
    while let Some((next, entering)) = next_alt_screen_event(bytes, cursor) {
        state = entering;
        cursor = next;
    }
    state
}

// --- 启发式 ------------------------------------------------------------------

/// 启发式：判断这段数据像不像 Windows 英文 cmd.exe 在 resize 时常见的全屏重绘帧。
///
/// 局限性（**有意保留**）：
/// - 仅匹配英文 cmd.exe 文案；非英文 locale、PowerShell、bash/zsh/fish、WSL 均不命中。
/// - 任何文案变化都会失效；属于 best-effort 信号，不应用于关键路径决策。
pub fn is_likely_interactive_resize_repaint_frame(data: &str) -> bool {
    data.contains("\x1b[H")
        && data.contains("\x1b[K")
        && (data.contains("To run a command as administrator")
            || data.contains("sudo <command>"))
}