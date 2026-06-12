use super::super::{DocumentEncoding, decode_script_bytes};
use super::preview::{
    build_line_previews, build_replacement_diff, compute_line_start_offsets,
    line_number_from_starts, replacement_edit_preview_id,
};
use super::scan::{ScannedFile, is_shell_like_file, relative_path};
use super::types::{
    WorkspaceReplacementFilePreview, WorkspaceReplacementLinePreview,
    WorkspaceReplacementPreviewPayload, WorkspaceReplacementRequest,
};
use super::util::{count_to_u32, hash_text};
use ast_grep_core::Pattern as AstPattern;
use ast_grep_language::{LanguageExt, SupportLang};
use rayon::prelude::*;
use std::{
    collections::HashSet,
    fs,
    ops::Range,
    path::{Path, PathBuf},
};

const MAX_REPLACEMENT_DIFF_INPUT_BYTES: usize = 512 * 1024;
const MAX_REPLACEMENT_DIFF_EDIT_COUNT: usize = 2_000;

pub(super) struct RegexReplacement {
    regex: regex::Regex,
    replacement: String,
}

pub(super) enum ReplacementPlan {
    Regex(RegexReplacement),
    Structural(AstPattern),
}

#[derive(Clone)]
pub(super) struct ReplacementEdit {
    pub(super) range: Range<usize>,
    pub(super) inserted_text: String,
}

pub(super) struct FileReplacementPreview {
    pub(super) path: PathBuf,
    pub(super) relative_path: String,
    pub(super) replacement_count: usize,
    pub(super) before_hash: String,
    pub(super) after_hash: String,
    pub(super) before_content: String,
    pub(super) encoding: DocumentEncoding,
    pub(super) diff: String,
    pub(super) diff_truncated: bool,
    pub(super) edits: Vec<ReplacementEdit>,
    pub(super) line_previews: Vec<WorkspaceReplacementLinePreview>,
}

pub(super) fn build_replacement_previews(
    workspace_root: &Path,
    files: &[ScannedFile],
    payload: &WorkspaceReplacementRequest,
    plan: &ReplacementPlan,
    limit: usize,
) -> Result<Vec<FileReplacementPreview>, String> {
    let mut previews = files
        .par_iter()
        .map(|file| build_file_replacement_preview(workspace_root, file, payload, plan))
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    if previews.len() > limit {
        return Err(format!(
            "替换范围超过 {limit} 个文件，请缩小搜索词或路径过滤后重试。"
        ));
    }

    previews.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(previews)
}

pub(super) fn build_file_replacement_preview(
    workspace_root: &Path,
    file: &ScannedFile,
    payload: &WorkspaceReplacementRequest,
    plan: &ReplacementPlan,
) -> Result<Option<FileReplacementPreview>, String> {
    let bytes = match fs::read(&file.path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let (content, encoding) = match decode_script_bytes(&bytes) {
        Ok(decoded) => decoded,
        Err(_) => return Ok(None),
    };

    let edits = match plan {
        ReplacementPlan::Structural(pattern) => {
            collect_structural_replacement_edits(file, &content, pattern, &payload.replacement)?
        }
        ReplacementPlan::Regex(regex_replacement) => {
            collect_regex_replacement_edits(&content, regex_replacement)?
        }
    };

    let Some(edits) = edits else {
        return Ok(None);
    };
    let after_content = apply_replacement_edits(&content, &edits);
    if after_content == content {
        return Ok(None);
    }
    let line_previews = build_line_previews(&content, &edits)?;
    let replacement_count = edits.len();

    let before_hash = hash_text(&content);
    let after_hash = hash_text(&after_content);
    let (diff, diff_truncated) = build_budgeted_replacement_diff(
        &file.relative_path,
        &content,
        &after_content,
        replacement_count,
    );

    Ok(Some(FileReplacementPreview {
        path: file.path.clone(),
        relative_path: relative_path(workspace_root, &file.path),
        replacement_count,
        before_hash,
        after_hash,
        before_content: content,
        encoding,
        diff,
        diff_truncated,
        edits,
        line_previews,
    }))
}

pub(super) fn build_replacement_preview_payload(
    workspace_root: PathBuf,
    previews: Vec<FileReplacementPreview>,
) -> Result<WorkspaceReplacementPreviewPayload, String> {
    let replacement_count = previews
        .iter()
        .try_fold(0usize, |total, file| {
            total.checked_add(file.replacement_count)
        })
        .ok_or_else(|| "替换数量超出支持范围。".to_string())?;
    let files = previews
        .into_iter()
        .map(|file| {
            Ok(WorkspaceReplacementFilePreview {
                path: file.path.to_string_lossy().to_string(),
                relative_path: file.relative_path,
                replacement_count: count_to_u32(file.replacement_count, "替换数量")?,
                before_hash: file.before_hash,
                after_hash: file.after_hash,
                diff: file.diff,
                diff_truncated: file.diff_truncated,
                line_previews: file.line_previews,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(WorkspaceReplacementPreviewPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        file_count: count_to_u32(files.len(), "文件数量")?,
        replacement_count: count_to_u32(replacement_count, "替换数量")?,
        files,
    })
}

pub(super) fn build_replacement_plan(
    payload: &WorkspaceReplacementRequest,
    query: &str,
) -> Result<ReplacementPlan, String> {
    if payload.use_structural {
        return Ok(ReplacementPlan::Structural(build_structural_pattern(
            query,
        )?));
    }

    build_regex_replacement(payload, query).map(ReplacementPlan::Regex)
}

fn build_regex_replacement(
    payload: &WorkspaceReplacementRequest,
    query: &str,
) -> Result<RegexReplacement, String> {
    let pattern = build_regex_pattern(query, payload.use_regex, payload.whole_word);
    let regex = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!payload.match_case)
        .unicode(true)
        .build()
        .map_err(|error| format!("替换表达式无效：{error}"))?;
    let replacement = if payload.use_regex {
        payload.replacement.clone()
    } else {
        payload.replacement.replace('$', "$$")
    };

    Ok(RegexReplacement { regex, replacement })
}

fn build_regex_pattern(query: &str, use_regex: bool, whole_word: bool) -> String {
    let pattern = if use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };

    if whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    }
}

fn collect_regex_replacement_edits(
    content: &str,
    replacement: &RegexReplacement,
) -> Result<Option<Vec<ReplacementEdit>>, String> {
    let mut edits = Vec::new();
    for captures in replacement.regex.captures_iter(content) {
        let Some(found) = captures.get(0) else {
            continue;
        };
        if found.start() == found.end() {
            return Err("替换表达式不能匹配空字符串。".to_string());
        }

        let mut inserted_text = String::new();
        captures.expand(replacement.replacement.as_str(), &mut inserted_text);
        edits.push(ReplacementEdit {
            range: found.start()..found.end(),
            inserted_text,
        });
    }

    if edits.is_empty() {
        return Ok(None);
    }

    Ok(Some(edits))
}

pub(super) fn build_structural_pattern(query: &str) -> Result<AstPattern, String> {
    AstPattern::try_new(query, SupportLang::Bash)
        .map_err(|error| format!("结构化搜索模式无效：{error}"))
}

fn collect_structural_replacement_edits(
    file: &ScannedFile,
    content: &str,
    pattern: &AstPattern,
    replacement: &str,
) -> Result<Option<Vec<ReplacementEdit>>, String> {
    if !is_shell_like_file(file) {
        return Ok(None);
    }

    let lang = SupportLang::Bash;
    let root = lang.ast_grep(content);
    let mut edits = root
        .root()
        .find_all(pattern)
        .map(|node_match| {
            let edit = node_match.make_edit(pattern, &replacement);
            let inserted_text = String::from_utf8(edit.inserted_text)
                .map_err(|error| format!("结构化替换模板生成失败：{error}"))?;
            Ok(ReplacementEdit {
                range: edit.position..edit.position + edit.deleted_length,
                inserted_text,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    edits = retain_non_overlapping_edits(edits);
    if edits.is_empty() {
        return Ok(None);
    }

    Ok(Some(edits))
}

pub(super) fn apply_replacement_edits(content: &str, edits: &[ReplacementEdit]) -> String {
    let mut after_content = content.to_string();
    for edit in edits.iter().rev() {
        after_content.replace_range(edit.range.clone(), &edit.inserted_text);
    }
    after_content
}

fn build_budgeted_replacement_diff(
    relative_path: &str,
    before_content: &str,
    after_content: &str,
    replacement_count: usize,
) -> (String, bool) {
    let total_input_bytes = before_content.len().saturating_add(after_content.len());
    if total_input_bytes > MAX_REPLACEMENT_DIFF_INPUT_BYTES
        || replacement_count > MAX_REPLACEMENT_DIFF_EDIT_COUNT
    {
        return (
            format!(
                "Diff 过大已省略：{relative_path}（{replacement_count} 次替换，{} → {} 字节）。请使用行级预览确认变更。",
                before_content.len(),
                after_content.len()
            ),
            true,
        );
    }

    build_replacement_diff(relative_path, before_content, after_content)
}

fn retain_non_overlapping_edits(mut edits: Vec<ReplacementEdit>) -> Vec<ReplacementEdit> {
    edits.sort_by(|left, right| {
        left.range
            .start
            .cmp(&right.range.start)
            .then_with(|| right.range.end.cmp(&left.range.end))
    });

    let mut retained = Vec::new();
    let mut previous_end = 0usize;
    for edit in edits {
        if edit.range.start < previous_end {
            continue;
        }

        previous_end = edit.range.end;
        retained.push(edit);
    }

    retained
}

pub(super) fn select_replacement_edits(
    replacement: &FileReplacementPreview,
    included_match_ids: &[String],
) -> Result<Vec<ReplacementEdit>, String> {
    if included_match_ids.is_empty() {
        return Ok(replacement.edits.clone());
    }

    let included = included_match_ids
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let line_starts = compute_line_start_offsets(&replacement.before_content);
    let selected = replacement
        .edits
        .iter()
        .map(|edit| {
            let line_number = line_number_from_starts(&line_starts, edit.range.start)?;
            let id = replacement_edit_preview_id(line_number, edit);
            Ok(included.contains(id.as_str()).then(|| edit.clone()))
        })
        .collect::<Result<Vec<_>, String>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgeted_replacement_diff_uses_regular_diff_for_small_inputs() {
        let (diff, truncated) =
            build_budgeted_replacement_diff("script.sh", "echo old\n", "echo new\n", 1);
        assert!(!truncated);
        assert!(diff.contains("script.sh"));
    }

    #[test]
    fn budgeted_replacement_diff_omits_oversized_inputs() {
        let before = "a".repeat(MAX_REPLACEMENT_DIFF_INPUT_BYTES / 2 + 1);
        let after = "b".repeat(MAX_REPLACEMENT_DIFF_INPUT_BYTES / 2 + 1);

        let (diff, truncated) = build_budgeted_replacement_diff("large.sh", &before, &after, 1);

        assert!(truncated);
        assert!(diff.contains("Diff 过大已省略"));
        assert!(diff.contains("large.sh"));
    }

    #[test]
    fn budgeted_replacement_diff_omits_too_many_edits() {
        let (diff, truncated) = build_budgeted_replacement_diff(
            "many.sh",
            "echo old\n",
            "echo new\n",
            MAX_REPLACEMENT_DIFF_EDIT_COUNT + 1,
        );

        assert!(truncated);
        assert!(diff.contains("Diff 过大已省略"));
    }
}
