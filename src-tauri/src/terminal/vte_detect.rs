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
