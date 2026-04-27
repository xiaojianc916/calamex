use std::time::Instant;

const TERMINAL_SNAPSHOT_MAX_LENGTH: usize = 160 * 1024;

#[derive(Clone, Copy, Default)]
pub struct TerminalInteractiveVisualState {
    pub resize_repaint_suppress_until: Option<Instant>,
    pub alt_screen_active: bool,
}

pub fn trim_terminal_snapshot(snapshot: &mut String) {
    if snapshot.len() <= TERMINAL_SNAPSHOT_MAX_LENGTH {
        return;
    }

    let excess = snapshot.len() - TERMINAL_SNAPSHOT_MAX_LENGTH;
    let boundary = advance_char_boundary(snapshot, excess);
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

pub fn contains_csi_final(data: &str, final_bytes: &[u8]) -> bool {
    let bytes = data.as_bytes();
    let mut index = 0;

    while index + 2 < bytes.len() {
        if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
            index += 1;
            continue;
        }

        let mut cursor = index + 2;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if (0x40..=0x7e).contains(&byte) {
                if final_bytes.contains(&byte) {
                    return true;
                }
                index = cursor + 1;
                break;
            }
            cursor += 1;
        }

        if cursor >= bytes.len() {
            break;
        }
    }

    false
}

pub fn contains_alt_screen_switch(data: &str) -> bool {
    let bytes = data.as_bytes();
    let mut index = 0;

    while index + 2 < bytes.len() {
        if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
            index += 1;
            continue;
        }

        let params_start = index + 2;
        let mut cursor = params_start;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if (0x40..=0x7e).contains(&byte) {
                let final_byte = byte;
                if matches!(final_byte, b'h' | b'l') {
                    let params = data.get(params_start..cursor).unwrap_or_default();
                    if csi_private_params_contain(params, &[47, 1047, 1049]) {
                        return true;
                    }
                }
                index = cursor + 1;
                break;
            }
            cursor += 1;
        }

        if cursor >= bytes.len() {
            break;
        }
    }

    false
}

pub fn resolve_alt_screen_state_after_data(current: bool, data: &str) -> bool {
    let bytes = data.as_bytes();
    let mut index = 0;
    let mut active = current;

    while index + 2 < bytes.len() {
        if bytes[index] != 0x1b || bytes[index + 1] != b'[' {
            index += 1;
            continue;
        }

        let params_start = index + 2;
        let mut cursor = params_start;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if (0x40..=0x7e).contains(&byte) {
                if let Some(params) = data.get(params_start..cursor) {
                    if csi_private_params_contain(params, &[47, 1047, 1049]) {
                        active = byte == b'h';
                    }
                }
                index = cursor + 1;
                break;
            }
            cursor += 1;
        }

        if cursor >= bytes.len() {
            break;
        }
    }

    active
}

pub fn is_likely_interactive_resize_repaint_frame(data: &str) -> bool {
    data.contains("\x1b[H")
        && data.contains("\x1b[K")
        && (data.contains("To run a command as administrator") || data.contains("sudo <command>"))
}

fn csi_private_params_contain(params: &str, needles: &[u16]) -> bool {
    let Some(private_params) = params.strip_prefix('?') else {
        return false;
    };

    private_params.split(';').any(|part| {
        let digits = part
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .collect::<Vec<_>>();
        if digits.is_empty() {
            return false;
        }

        std::str::from_utf8(&digits)
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .is_some_and(|value| needles.contains(&value))
    })
}
