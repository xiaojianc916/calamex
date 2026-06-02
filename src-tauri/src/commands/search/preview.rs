use super::replace::ReplacementEdit;
use super::types::WorkspaceReplacementLinePreview;
use super::util::{count_to_u32, hash_text};
use similar::TextDiff;
use std::ops::Range;

const MAX_DIFF_CHARS: usize = 8_000;
const REPLACEMENT_PREVIEW_CONTEXT_CHARS: usize = 32;
const COMPACT_PREVIEW_ELLIPSIS: &str = "…";

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
            let (before_line, after_line) =
                build_single_match_preview(line, match_start, match_end, &edit.inserted_text)
                    .ok_or_else(|| "构建替换预览失败。".to_string())?;
            Ok(WorkspaceReplacementLinePreview {
                id: replacement_edit_preview_id(line_number, edit),
                line_number,
                before_line,
                after_line,
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

fn build_single_match_preview(
    line: &str,
    match_start: usize,
    match_end: usize,
    inserted_text: &str,
) -> Option<(String, String)> {
    if match_start > match_end || match_end > line.len() {
        return None;
    }

    let prefix = &line[..match_start];
    let matched = &line[match_start..match_end];
    let suffix = &line[match_end..];
    let prefix_preview = trailing_chars(prefix, REPLACEMENT_PREVIEW_CONTEXT_CHARS);
    let suffix_preview = leading_chars(suffix, REPLACEMENT_PREVIEW_CONTEXT_CHARS);
    let before_ellipsis = if prefix.chars().count() > REPLACEMENT_PREVIEW_CONTEXT_CHARS {
        COMPACT_PREVIEW_ELLIPSIS
    } else {
        ""
    };
    let after_ellipsis = if suffix.chars().count() > REPLACEMENT_PREVIEW_CONTEXT_CHARS {
        COMPACT_PREVIEW_ELLIPSIS
    } else {
        ""
    };
    let before_line = format!(
        "{before_ellipsis}{prefix_preview}{}{suffix_preview}{after_ellipsis}",
        single_line_preview_text(matched)
    );
    let after_line = format!(
        "{before_ellipsis}{prefix_preview}{}{suffix_preview}{after_ellipsis}",
        single_line_preview_text(inserted_text)
    );

    if before_line == after_line {
        return None;
    }

    Some((before_line, after_line))
}

fn leading_chars(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn trailing_chars(value: &str, limit: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    chars
        .iter()
        .skip(chars.len().saturating_sub(limit))
        .copied()
        .collect()
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
