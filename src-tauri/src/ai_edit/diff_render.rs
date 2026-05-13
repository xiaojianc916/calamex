//! AED 行级 diff 与 hunk 反向应用工具。
//!
//! 设计要点：
//! - `render_patch_hunks` 基于 `diffy` 生成标准 unified diff hunk。
//! - `apply_reverse_hunk` 将单个 hunk 转为 `diffy` patch 后反向作用到「应用后」文本上。
//! - 多 hunk 反向请使用 `apply_reverse_hunks`（内部按 `new_start` 逆序作用），
//!   避免前一个 hunk 的撤销改变后续 hunk 的行偏移。
//! - 行号约定：1-based；`old_lines = 0` 表示纯插入，`new_lines = 0` 表示纯删除。

use crate::commands::contracts::AiPatchHunkPayload;
use diffy::{DiffOptions, Line, Patch};

const NO_NEWLINE_AT_EOF: &str = "\\ No newline at end of file";

#[derive(Debug, Clone)]
pub struct RenderedDiff {
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<AiPatchHunkPayload>,
}

/// 渲染 before → after 的行级 diff。
pub fn render_patch_hunks(before: &str, after: &str) -> RenderedDiff {
    let mut additions = 0u32;
    let mut deletions = 0u32;
    let mut hunks = Vec::new();

    let mut options = DiffOptions::new();
    options.set_context_len(0);
    let patch = options.create_patch(before, after);

    for hunk in patch.hunks() {
        let old_range = hunk.old_range();
        let new_range = hunk.new_range();
        let mut lines = Vec::new();

        for line in hunk.lines() {
            match line {
                Line::Context(value) => push_payload_line(&mut lines, ' ', value),
                Line::Delete(value) => {
                    deletions += 1;
                    push_payload_line(&mut lines, '-', value);
                }
                Line::Insert(value) => {
                    additions += 1;
                    push_payload_line(&mut lines, '+', value);
                }
            }
        }

        hunks.push(AiPatchHunkPayload {
            old_start: to_payload_line_start(old_range.start()),
            old_lines: old_range.len() as u32,
            new_start: to_payload_line_start(new_range.start()),
            new_lines: new_range.len() as u32,
            lines,
        });
    }

    RenderedDiff {
        additions,
        deletions,
        hunks,
    }
}

/// 将单个 hunk 反向作用到「应用后」文本上，恢复对应区段为 before 状态。
///
/// 严格校验：当前文件 `[new_start, new_start + new_lines)` 区段必须与 hunk
/// 中的 `+` 行完全一致，否则报错而不是静默写坏。
pub fn apply_reverse_hunk(after: &str, hunk: &AiPatchHunkPayload) -> Result<String, String> {
    let patch_text = build_single_hunk_patch(hunk)?;
    let patch = Patch::from_str(&patch_text).map_err(|error| {
        format!("解析 hunk 失败：{error}")
    })?;
    diffy::apply(after, &patch.reverse()).map_err(|error| {
        format!("当前文件片段与目标 hunk 不一致：{error}")
    })
}

/// 将一组 hunk 一次性反向作用到「应用后」文本上。
///
/// 内部按 `new_start` 降序应用，保证前一次撤销不会污染后续 hunk 的行偏移。
/// 任意 hunk 失败会立即返回，且不会保留半成品（在副本上构建）。
pub fn apply_reverse_hunks(after: &str, hunks: &[AiPatchHunkPayload]) -> Result<String, String> {
    let mut ordered: Vec<&AiPatchHunkPayload> = hunks.iter().collect();
    ordered.sort_by(|a, b| b.new_start.cmp(&a.new_start));

    let mut current = after.to_string();
    for hunk in ordered {
        current = apply_reverse_hunk(&current, hunk)?;
    }
    Ok(current)
}

fn build_single_hunk_patch(hunk: &AiPatchHunkPayload) -> Result<String, String> {
    let mut patch = String::from("--- original\n+++ modified\n");
    patch.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
    ));

    for line in &hunk.lines {
        validate_patch_line(line)?;
        patch.push_str(line);
        patch.push('\n');
    }

    Ok(patch)
}

fn validate_patch_line(line: &str) -> Result<(), String> {
    if line.contains('\n') {
        return Err("hunk 行不能包含换行符。".to_string());
    }
    if line == NO_NEWLINE_AT_EOF {
        return Ok(());
    }
    if matches!(line.as_bytes().first(), Some(b' ' | b'+' | b'-')) {
        return Ok(());
    }
    Err("hunk 行必须以空格、+ 或 - 开头。".to_string())
}

fn push_payload_line(lines: &mut Vec<String>, prefix: char, value: &str) {
    lines.push(format!("{prefix}{}", strip_diffy_line(value)));
    if !value.ends_with('\n') {
        lines.push(NO_NEWLINE_AT_EOF.to_string());
    }
}

fn strip_diffy_line(value: &str) -> &str {
    value.strip_suffix('\n').unwrap_or(value)
}

fn to_payload_line_start(start: usize) -> u32 {
    start.saturating_add(1) as u32
}

#[cfg(test)]
mod tests {
    use super::{apply_reverse_hunk, apply_reverse_hunks, render_patch_hunks};

    #[test]
    fn render_patch_hunks_splits_multiple_change_groups() {
        let rendered = render_patch_hunks(
            "line-1\nline-2\nline-3\nline-4",
            "line-1\nline-2-updated\nline-3\nline-4-updated",
        );
        assert_eq!(rendered.hunks.len(), 2);
        assert_eq!(rendered.additions, 2);
        assert_eq!(rendered.deletions, 2);
        assert_eq!(rendered.hunks[0].old_start, 2);
        assert_eq!(rendered.hunks[1].old_start, 4);
    }

    #[test]
    fn apply_reverse_hunk_restores_selected_segment() {
        let rendered = render_patch_hunks("a\nb\nc", "a\nB\nc");
        let reverted =
            apply_reverse_hunk("a\nB\nc", &rendered.hunks[0]).expect("reverse hunk should apply");
        assert_eq!(reverted, "a\nb\nc");
    }

    #[test]
    fn empty_before_pure_insert_round_trip() {
        let before = "";
        let after = "a\nb";
        let rendered = render_patch_hunks(before, after);
        assert_eq!(rendered.additions, 2);
        assert_eq!(rendered.deletions, 0);

        let reverted = apply_reverse_hunks(after, &rendered.hunks).expect("reverse ok");
        assert_eq!(reverted, before);
    }

    #[test]
    fn pure_delete_to_empty_round_trip() {
        let before = "a\nb";
        let after = "";
        let rendered = render_patch_hunks(before, after);
        assert_eq!(rendered.additions, 0);
        assert_eq!(rendered.deletions, 2);

        let reverted = apply_reverse_hunks(after, &rendered.hunks).expect("reverse ok");
        assert_eq!(reverted, before);
    }

    #[test]
    fn trailing_newline_is_preserved() {
        let before = "a\nb\n";
        let after = "a\nB\n";
        let rendered = render_patch_hunks(before, after);
        let reverted = apply_reverse_hunks(after, &rendered.hunks).expect("reverse ok");
        assert_eq!(reverted, before);
    }

    #[test]
    fn reverse_hunks_applied_in_reverse_order() {
        let before = "l1\nl2\nl3\nl4\nl5";
        let after = "l1\nL2\nl3\nL4\nl5";
        let rendered = render_patch_hunks(before, after);
        assert_eq!(rendered.hunks.len(), 2);

        // 调用方即便按正序传入，apply_reverse_hunks 内部也会逆序处理。
        let reverted = apply_reverse_hunks(after, &rendered.hunks).expect("reverse ok");
        assert_eq!(reverted, before);
    }

    #[test]
    fn apply_reverse_hunk_detects_drift() {
        let rendered = render_patch_hunks("a\nb\nc", "a\nB\nc");
        // 文件已经被进一步改动，应该拒绝撤销而不是静默写坏。
        let drifted = "a\nX\nc";
        let err = apply_reverse_hunk(drifted, &rendered.hunks[0])
            .expect_err("should refuse to apply on drifted file");
        assert!(err.contains("不一致"));
    }

    #[test]
    fn pure_insertion_hunk_reverse() {
        let before = "a\nc";
        let after = "a\nb\nc";
        let rendered = render_patch_hunks(before, after);
        assert_eq!(rendered.hunks.len(), 1);
        assert_eq!(rendered.hunks[0].old_lines, 0);
        assert_eq!(rendered.hunks[0].new_lines, 1);

        let reverted = apply_reverse_hunks(after, &rendered.hunks).expect("reverse ok");
        assert_eq!(reverted, before);
    }

    #[test]
    fn pure_deletion_hunk_reverse() {
        let before = "a\nb\nc";
        let after = "a\nc";
        let rendered = render_patch_hunks(before, after);
        assert_eq!(rendered.hunks.len(), 1);
        assert_eq!(rendered.hunks[0].old_lines, 1);
        assert_eq!(rendered.hunks[0].new_lines, 0);

        let reverted = apply_reverse_hunks(after, &rendered.hunks).expect("reverse ok");
        assert_eq!(reverted, before);
    }

    #[test]
    fn out_of_bounds_hunk_is_rejected() {
        let mut rendered = render_patch_hunks("a\nb\nc", "a\nB\nc");
        // 故意把 new_start 推到越界位置。
        rendered.hunks[0].new_start = 999;
        let err = apply_reverse_hunk("a\nB\nc", &rendered.hunks[0])
            .expect_err("should reject out-of-bounds");
        assert!(err.contains("越界"));
    }
}
