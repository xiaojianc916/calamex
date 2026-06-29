use vte::{Params, Parser, Perform};

/// 通过 vte 解析器从 ANSI 数据流中检测特定 CSI 事件。
/// 基于 Alacritty 使用的 vte crate 提供符合 ECMA-48 标准的 CSI 解析。

#[derive(Debug, Clone, Copy, Default)]
pub struct AnsiCsiEvents {
    pub alt_screen_switched: bool,
    pub alt_screen_active: bool,
}

/// 用单个 vte 解析器扫描整段数据并返回检测结果。
/// 供 `scan_ansi_csi_events` 复用，集中 CSI 解析循环。
fn detect_csi_events(data: &str) -> CsiDetector {
    let mut detector = CsiDetector::default();
    if data.is_empty() {
        return detector;
    }

    let mut parser = Parser::new();
    // 一次性把整段字节交给解析器，避免逐字节调用 advance 带来的额外开销。
    parser.advance(&mut detector, data.as_bytes());
    detector
}

pub fn scan_ansi_csi_events(data: &str) -> AnsiCsiEvents {
    let detector = detect_csi_events(data);
    AnsiCsiEvents {
        alt_screen_switched: detector.alt_screen_switched,
        alt_screen_active: detector.alt_screen_active,
    }
}


#[derive(Debug, Default)]
struct CsiDetector {
    private_mode: bool,
    alt_screen_switched: bool,
    alt_screen_active: bool,
}

/// 当 CSI 序列「恰好只有一个参数」时返回其首个子参数值，否则返回 None。
/// 等价于原先 `params.iter().map(|p| p[0]).collect::<Vec<_>>()` 后判断 `slice == [x]`，
/// 但无需为每次分发分配临时 Vec。
fn single_param_value(params: &Params) -> Option<u16> {
    let mut iter = params.iter();
    let first = iter.next()?;
    if iter.next().is_some() {
        return None;
    }
    first.first().copied()
}

impl Perform for CsiDetector {
    fn print(&mut self, _c: char) {}

    fn execute(&mut self, _byte: u8) {}

    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {}

    fn put(&mut self, _byte: u8) {}

    fn unhook(&mut self) {}

    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {}

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        self.private_mode = intermediates.first() == Some(&b'?');

        match action {
            'h' | 'l' if self.private_mode => {
                let entering = action == 'h';
                if matches!(single_param_value(params), Some(47 | 1047 | 1049)) {
                    self.alt_screen_switched = true;
                    self.alt_screen_active = entering;
                }
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}
// ============================================================================
// 全屏交互式重绘帧检测（locale 无关，替代 snapshot.rs 旧的英文文案启发式）
// ============================================================================

/// 全屏重绘帧的结构化特征检测器：光标归位（CUP→home）+ 整屏擦除（ED 2/3）或多次行擦除（EL）。
/// 不依赖任何自然语言文案，因此对中文 / 任意 locale 的 Windows 都稳定。
#[derive(Debug, Default)]
struct RepaintDetector {
    cursor_home: bool,
    erase_in_display_all: bool,
    erase_in_line_count: u32,
}

impl Perform for RepaintDetector {
    fn print(&mut self, _c: char) {}
    fn execute(&mut self, _byte: u8) {}
    fn hook(&mut self, _params: &Params, _intermediates: &[u8], _ignore: bool, _action: char) {}
    fn put(&mut self, _byte: u8) {}
    fn unhook(&mut self) {}
    fn osc_dispatch(&mut self, _params: &[&[u8]], _bell_terminated: bool) {}

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
        // 私有模式序列（CSI ? ...）不参与重绘判定。
        if intermediates.first() == Some(&b'?') {
            return;
        }
        match action {
            // CUP / HVP：无参数或定位到 (1,1) 视为光标归位 home。
            'H' | 'f' => {
                let mut iter = params.iter();
                let row = iter.next().and_then(|p| p.first().copied()).unwrap_or(1);
                let col = iter.next().and_then(|p| p.first().copied()).unwrap_or(1);
                if row <= 1 && col <= 1 {
                    self.cursor_home = true;
                }
            }
            // ED：参数 2（整屏）/ 3（含回滚缓冲）视为整屏擦除。
            'J' => {
                if matches!(single_param_value(params), Some(2 | 3)) {
                    self.erase_in_display_all = true;
                }
            }
            // EL：擦除行。
            'K' => {
                self.erase_in_line_count = self.erase_in_line_count.saturating_add(1);
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, _intermediates: &[u8], _ignore: bool, _byte: u8) {}
}

/// 判定一段数据是否为「整屏交互式重绘帧」。
///
/// 用标准 VT 状态机按 CSI 指令语义判定，替代旧的 .contains("\x1b[H") 裸字节匹配 +
/// 英文文案（"To run a command as administrator" / "sudo <command>"）启发式：
/// 旧做法依赖英文 locale，中文 Windows / 改过 UAC 文案即失效；新做法 locale 无关。
///
/// 结构化特征：光标归位 且（整屏擦除 ED2/3 或 ≥ MIN_LINE_ERASES_FOR_REPAINT 次行擦除）。
pub fn is_full_screen_repaint_frame(data: &str) -> bool {
    // 行擦除阈值：单次 EL 多为普通输出；整屏重绘会成片擦除多行。需结合真实 resize 帧标定，先取保守值 2。
    const MIN_LINE_ERASES_FOR_REPAINT: u32 = 2;

    if data.is_empty() {
        return false;
    }
    let mut detector = RepaintDetector::default();
    let mut parser = Parser::new();
    parser.advance(&mut detector, data.as_bytes());
    detector.cursor_home
        && (detector.erase_in_display_all
            || detector.erase_in_line_count >= MIN_LINE_ERASES_FOR_REPAINT)
}

#[cfg(test)]
mod repaint_tests {
    use super::*;

    #[test]
    fn detects_home_plus_full_erase() {
        assert!(is_full_screen_repaint_frame("\x1b[H\x1b[2Jredrawn"));
    }

    #[test]
    fn detects_home_plus_multiple_line_erases() {
        assert!(is_full_screen_repaint_frame("\x1b[H\x1b[Kline1\x1b[Kline2"));
    }

    #[test]
    fn locale_independent_chinese_prompt() {
        // 回归：旧实现要求英文 "To run a command as administrator"，中文 Windows 会漏判；
        // 新实现只看 VT 指令，中文文案同样命中。
        let frame = "\x1b[H\x1b[K请以管理员身份运行此命令\x1b[K\x1b[2J";
        assert!(is_full_screen_repaint_frame(frame));
    }

    #[test]
    fn plain_output_is_not_repaint() {
        assert!(!is_full_screen_repaint_frame("just some normal output\n"));
        assert!(!is_full_screen_repaint_frame("\x1b[Ksingle line erase only"));
    }

    #[test]
    fn empty_is_not_repaint() {
        assert!(!is_full_screen_repaint_frame(""));
    }
}
