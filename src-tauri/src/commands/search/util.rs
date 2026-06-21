pub(super) fn require_replacement_query(query: &str) -> Result<String, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("替换前请先输入搜索内容。".to_string());
    }
    Ok(query)
}

pub(super) fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

pub(super) fn u64_to_u32(value: u64, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

pub(super) fn i64_to_i32(value: i64, label: &str) -> Result<i32, String> {
    i32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

pub(super) fn hash_text(value: &str) -> String {
    format!("blake3:{}", blake3::hash(value.as_bytes()).to_hex())
}

pub(super) fn trim_line(line: &str) -> String {
    line.trim_end_matches(['\r', '\n']).to_string()
}

pub(super) fn byte_to_char_offset(value: &str, byte_offset: usize) -> usize {
    value[..byte_offset.min(value.len())].chars().count()
}

/// 命中邻域窗口化：以命中所在的字节区间 [match_start_byte, match_end_byte] 为中心，按显示列
/// 预算从两侧扩展上下文，返回 (窗口文本, 窗口首字符在原行中的码点偏移, 左侧被裁, 右侧被裁)。
/// 命中本身尽量完整保留；列宽按东亚宽度计（CJK/全角/Emoji 记 2 列，其余 1 列）。只在命中两侧
/// 各走至多预算列数 → O(预算)、与行长解耦，超长行不会被整行复制。
pub(super) fn window_around_match(
    line: &str,
    match_start_byte: usize,
    match_end_byte: usize,
) -> (String, u32, bool, bool) {
    // 列预算上界：远超任何侧栏宽度；精确像素贴合交给前端，这里只负责把超长行裁成有界片段。
    const BUDGET_COLS: usize = 200;
    // 命中左侧保留的少量前导上下文：既不贴边，又让命中靠近起点，窄侧栏也能看到。
    const LEFT_MARGIN_COLS: usize = 8;

    let len = line.len();
    let start_byte = match_start_byte.min(len);
    let end_byte = match_end_byte.clamp(start_byte, len);

    let match_cols: usize = line[start_byte..end_byte]
        .chars()
        .map(char_display_cols)
        .sum();

    let left_budget = if match_cols >= BUDGET_COLS {
        0
    } else {
        LEFT_MARGIN_COLS.min(BUDGET_COLS - match_cols)
    };
    let mut window_start_byte = start_byte;
    let mut used_left = 0usize;
    for (offset, ch) in line[..start_byte].char_indices().rev() {
        let cols = char_display_cols(ch);
        if used_left + cols > left_budget {
            break;
        }
        used_left += cols;
        window_start_byte = offset;
    }

    // 命中未超预算：剩余预算全给右侧（命中完整保留）；命中超预算：从命中起点按总预算截断。
    let (right_from_byte, right_budget) = if match_cols >= BUDGET_COLS {
        (start_byte, BUDGET_COLS)
    } else {
        (end_byte, BUDGET_COLS - match_cols - used_left)
    };
    let mut window_end_byte = right_from_byte;
    let mut used_right = 0usize;
    for (offset, ch) in line[right_from_byte..].char_indices() {
        let cols = char_display_cols(ch);
        if used_right + cols > right_budget {
            break;
        }
        used_right += cols;
        window_end_byte = right_from_byte + offset + ch.len_utf8();
    }
    if match_cols < BUDGET_COLS {
        window_end_byte = window_end_byte.max(end_byte);
    }

    let truncated_left = window_start_byte > 0;
    let truncated_right = window_end_byte < len;
    let window_start_char = line[..window_start_byte].chars().count() as u32;
    let windowed = line[window_start_byte..window_end_byte].to_string();
    (windowed, window_start_char, truncated_left, truncated_right)
}

fn char_display_cols(ch: char) -> usize {
    if is_wide_char(ch) {
        2
    } else {
        1
    }
}

/// 东亚宽字符（占 2 个显示列）的码点区间判定：覆盖 CJK 统一表意、假名、谚文、全角符号、
/// CJK 兼容、Emoji 等常见宽字符；其余按 1 列。仅用于窗口列宽估算，不要求严格覆盖 EAW 边角。
fn is_wide_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x1100..=0x115F
            | 0x2329..=0x232A
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1B000..=0x1B16F
            | 0x1F300..=0x1FAFF
            | 0x20000..=0x3FFFD
    )
}
