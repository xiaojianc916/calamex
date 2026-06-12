use super::replace::ReplacementEdit;
use super::types::WorkspaceReplacementLinePreview;
use super::util::{count_to_u32, hash_text};
use similar::TextDiff;
use std::ops::Range;

const MAX_DIFF_CHARS: usize = 8_000;
/// 单侧上下文的安全上限（字符数）。远大于面板可视宽度，仅用于防止超长行撑爆 DOM；
/// 日常的视觉截断（含省略号）完全交给前端按真实宽度处理。
const MAX_PREVIEW_CONTEXT_CHARS: usize = 400;

/// 单个命中的结构化预览：整行文本 + 命中区间（UTF-16 偏移）+ 替换文本 + 截断标志。
struct SingleMatchPreview {
    before_line: String,
    inserted_text: String,
    match_start: u32,
    match_end: u32,
    truncated_start: bool,
    truncated_end: bool,
}

pub(super) fn build_line_previews(
    before_content: &str,
    edits: &[ReplacementEdit],
) -> Result<Vec<WorkspaceReplacementLinePreview>, String> {
    let line_starts = compute_line_start_offsets(before_content);
    edits
        .iter()
        .map(|edit| {
            let line_number = line_number_from_starts(&line_starts, edit.range.start)?;
            let line_range =
                line_bounds_from_starts(&line_starts, before_content, edit.range.start);
            let line = &before_content[line_range.clone()];
            let match_start = edit.range.start.saturating_sub(line_range.start);
            let match_end = edit
                .range
                .end
                .saturating_sub(line_range.start)
                .min(line.len());
            let preview =
                build_single_match_preview(line, match_start, match_end, &edit.inserted_text)
                    .ok_or_else(|| "构建替换预览失败。".to_string())?;
            Ok(WorkspaceReplacementLinePreview {
                id: replacement_edit_preview_id(line_number, edit),
                line_number,
                before_line: preview.before_line,
                inserted_text: preview.inserted_text,
                match_start: preview.match_start,
                match_end: preview.match_end,
                truncated_start: preview.truncated_start,
                truncated_end: preview.truncated_end,
                replacement_count: 1,
            })
        })
        .collect()
}

/// 预计算每一行起始字节偏移（含首行 0），便于用二分查找将字节偏移映射到行号/行范围，
/// 避免对每个编辑都从头扫描换行符。
pub(super) fn compute_line_start_offsets(content: &str) -> Vec<usize> {
    let mut starts = Vec::with_capacity(16);
    starts.push(0);
    for (index, byte) in content.bytes().enumerate() {
        if byte == b'\n' {
            starts.push(index + 1);
        }
    }
    starts
}

pub(super) fn line_number_from_starts(
    line_starts: &[usize],
    byte_offset: usize,
) -> Result<u32, String> {
    let line_number = line_starts
        .partition_point(|&start| start <= byte_offset)
        .max(1);
    count_to_u32(line_number, "行号")
}

fn line_bounds_from_starts(
    line_starts: &[usize],
    content: &str,
    byte_offset: usize,
) -> Range<usize> {
    if content.is_empty() {
        return 0..0;
    }

    let safe_offset = byte_offset.min(content.len());
    let line_index = line_starts
        .partition_point(|&start| start <= safe_offset)
        .saturating_sub(1);
    let start = line_starts.get(line_index).copied().unwrap_or(0);
    let end = line_starts
        .get(line_index + 1)
        .map(|&next_start| next_start.saturating_sub(1))
        .unwrap_or(content.len());
    start..end
}

pub(super) fn line_range_at_byte_offset(content: &str, byte_offset: usize) -> Range<usize> {
    if content.is_empty() {
        return 0..0;
    }

    let safe_offset = byte_offset.min(content.len());
    let start = content[..safe_offset]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let end = content[safe_offset..]
        .find('\n')
        .map(|index| safe_offset + index)
        .unwrap_or(content.len());
    start..end
}

/// 构建单个命中的结构化预览。
///
/// 不再拼接省略号、不做固定字符窗口：
/// - 去掉行首缩进（仅作用于命中点之前的前缀）；
/// - 仅当任一侧超过安全上限时才截断并置位 truncated_* 标志；
/// - 命中区间以 UTF-16 code unit 偏移返回，便于前端直接 slice。
fn build_single_match_preview(
    line: &str,
    match_start: usize,
    match_end: usize,
    inserted_text: &str,
) -> Option<SingleMatchPreview> {
    if match_start > match_end || match_end > line.len() {
        return None;
    }

    let matched_norm = single_line_preview_text(&line[match_start..match_end]);
    let inserted_norm = single_line_preview_text(inserted_text);
    if matched_norm == inserted_norm {
        return None;
    }

    // 行首缩进只可能出现在命中点之前的前缀里，trim_start 即可去除。
    let prefix_norm = single_line_preview_text(&line[..match_start]);
    let trimmed_prefix = prefix_norm.trim_start();
    let suffix_norm = single_line_preview_text(&line[match_end..]);

    // 安全上限：仅在内容超长时截断，日常不触发。
    let (prefix_capped, truncated_start) = cap_trailing(trimmed_prefix, MAX_PREVIEW_CONTEXT_CHARS);
    let (suffix_capped, truncated_end) = cap_leading(&suffix_norm, MAX_PREVIEW_CONTEXT_CHARS);

    let match_start_u16 = utf16_len(&prefix_capped);
    let match_end_u16 = match_start_u16 + utf16_len(&matched_norm);
    let before_line = format!("{prefix_capped}{matched_norm}{suffix_capped}");

    Some(SingleMatchPreview {
        before_line,
        inserted_text: inserted_norm,
        match_start: count_to_u32(match_start_u16, "命中起始偏移").ok()?,
        match_end: count_to_u32(match_end_u16, "命中结束偏移").ok()?,
        truncated_start,
        truncated_end,
    })
}

/// 保留末尾 limit 个字符；发生截断时返回 (截断串, true)。
fn cap_trailing(value: &str, limit: usize) -> (String, bool) {
    let total = value.chars().count();
    if total <= limit {
        return (value.to_string(), false);
    }
    let kept = value.chars().skip(total - limit).collect();
    (kept, true)
}

/// 保留开头 limit 个字符；发生截断时返回 (截断串, true)。
fn cap_leading(value: &str, limit: usize) -> (String, bool) {
    let total = value.chars().count();
    if total <= limit {
        return (value.to_string(), false);
    }
    let kept = value.chars().take(limit).collect();
    (kept, true)
}

/// 字符串的 UTF-16 code unit 长度（与前端 JS string 偏移一致）。
fn utf16_len(value: &str) -> usize {
    value.chars().map(|c| c.len_utf16()).sum()
}

fn single_line_preview_text(value: &str) -> String {
    value.replace('\r', "").replace('\n', "\\n")
}

pub(super) fn replacement_edit_preview_id(line_number: u32, edit: &ReplacementEdit) -> String {
    format!(
        "match:{line_number}:{}:{}:{}",
        edit.range.start,
        edit.range.end,
        hash_text(&edit.inserted_text)
    )
}

pub(super) fn build_replacement_diff(
    relative_path: &str,
    before_content: &str,
    after_content: &str,
) -> (String, bool) {
    let before_label = format!("a/{relative_path}");
    let after_label = format!("b/{relative_path}");
    let diff = TextDiff::from_lines(before_content, after_content)
        .unified_diff()
        .context_radius(2)
        .header(&before_label, &after_label)
        .to_string();
    truncate_diff(diff)
}

fn truncate_diff(diff: String) -> (String, bool) {
    if diff.chars().count() <= MAX_DIFF_CHARS {
        return (diff, false);
    }

    let mut truncated = diff.chars().take(MAX_DIFF_CHARS).collect::<String>();
    truncated.push_str("\n... Diff 已截断，请缩小替换范围查看完整上下文 ...");
    (truncated, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(line: &str, start: usize, end: usize, inserted: &str) -> SingleMatchPreview {
        build_single_match_preview(line, start, end, inserted).expect("应生成预览")
    }

    #[test]
    fn trims_leading_indentation_and_keeps_offsets() {
        // "\t\tlet x = 1;"，命中 "1"（替换为 "2"）。
        let line = "\t\tlet x = 1;";
        let start = line.find('1').unwrap();
        let p = preview(line, start, start + 1, "2");
        // 行首两个制表符被去掉。
        assert_eq!(p.before_line, "let x = 1;");
        assert!(!p.truncated_start);
        assert!(!p.truncated_end);
        // 命中在去缩进后的 "let x = " 之后，UTF-16 偏移为 8。
        assert_eq!(p.match_start, 8);
        assert_eq!(p.match_end, 9);
        assert_eq!(p.inserted_text, "2");
    }

    #[test]
    fn utf16_offsets_account_for_astral_chars() {
        // emoji 占 2 个 UTF-16 code unit。
        let line = "😀ab";
        let start = "😀".len(); // 命中 "a" 的字节起点
        let p = preview(line, start, start + 1, "X");
        assert_eq!(p.match_start, 2);
        assert_eq!(p.match_end, 3);
    }

    #[test]
    fn caps_long_prefix_and_marks_truncated_start() {
        let prefix: String = "a".repeat(MAX_PREVIEW_CONTEXT_CHARS + 50);
        let line = format!("{prefix}1");
        let start = prefix.len();
        let p = preview(&line, start, start + 1, "2");
        assert!(p.truncated_start);
        assert!(!p.truncated_end);
        assert_eq!(p.match_start as usize, MAX_PREVIEW_CONTEXT_CHARS);
    }

    #[test]
    fn strips_trailing_carriage_return() {
        let line = "let x = 1;\r";
        let start = line.find('1').unwrap();
        let p = preview(line, start, start + 1, "2");
        assert!(!p.before_line.contains('\r'));
    }

    #[test]
    fn skips_when_no_visible_change() {
        let line = "abc";
        assert!(build_single_match_preview(line, 0, 1, "a").is_none());
    }
}
