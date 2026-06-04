mod find;
mod preview;
mod replace;
mod scan;
mod types;
mod util;

pub use types::*;

use super::{encode_script_content, resolve_workspace_root};
use find::{search_file_contents, search_file_names, search_structural_contents, search_symbols};
use replace::{
    apply_replacement_edits, build_file_replacement_preview, build_replacement_plan,
    build_replacement_preview_payload, build_replacement_previews, select_replacement_edits,
};
use scan::{
    build_path_filters, resolve_existing_workspace_file, scan_workspace_files,
    scanned_file_from_path,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use util::{count_to_u32, require_replacement_query, u64_to_u32};

const DEFAULT_SEARCH_LIMIT: usize = 200;
const MAX_SEARCH_LIMIT: usize = 2000;
const DEFAULT_REPLACEMENT_FILE_LIMIT: usize = 100;
const MAX_REPLACEMENT_FILE_LIMIT: usize = 500;

#[tauri::command]
#[specta::specta]
pub fn search_workspace(payload: WorkspaceSearchRequest) -> Result<WorkspaceSearchPayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.workspace_root_path.clone()))?;
    let query = payload.query.trim().to_string();
    let limit = payload
        .limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .min(MAX_SEARCH_LIMIT);
    let filters = build_path_filters(&payload.include_patterns, &payload.exclude_patterns)?;
    let files = scan_workspace_files(&workspace_root, &filters)?;

    if query.is_empty() {
        return Ok(WorkspaceSearchPayload {
            root_path: workspace_root.to_string_lossy().to_string(),
            scanned_file_count: count_to_u32(files.len(), "扫描文件数")?,
            results: Vec::new(),
        });
    }

    let mut results = Vec::new();
    let include_file_results = !payload.use_structural && payload.scope.includes_file_name();
    let include_content_results = payload.scope.includes_content();
    let include_symbol_results = !payload.use_structural && payload.scope.includes_symbol();

    if include_file_results {
        results.extend(search_file_names(
            &files,
            &query,
            payload.match_case,
            limit,
        )?);
    }

    if include_content_results && (payload.scope.is_all() || results.len() < limit) {
        let content_limit = if payload.scope.is_all() {
            limit
        } else {
            limit - results.len()
        };
        if payload.use_structural {
            results.extend(search_structural_contents(&files, &query, content_limit)?);
        } else {
            results.extend(search_file_contents(
                &files,
                &query,
                &payload,
                content_limit,
            )?);
        }
    }

    if include_symbol_results && (payload.scope.is_all() || results.len() < limit) {
        let symbol_limit = if payload.scope.is_all() {
            limit
        } else {
            limit - results.len()
        };
        results.extend(search_symbols(
            &workspace_root,
            &filters,
            &query,
            payload.match_case,
            symbol_limit,
        )?);
    }

    // 按分数排序以便“全部”视图呈现稳定顺序。注意：all 范围下每个类别已各自限额为
    // limit，这里不再跨类别截断到单个 limit，以免文件名命中（分数恒为大负数）占满名额后，
    // 内容/符号结果被整体挤掉。
    results.sort_by(|left, right| {
        left.score
            .cmp(&right.score)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });

    Ok(WorkspaceSearchPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        scanned_file_count: count_to_u32(files.len(), "扫描文件数")?,
        results,
    })
}

#[tauri::command]
#[specta::specta]
pub fn preview_workspace_replacement(
    payload: WorkspaceReplacementRequest,
) -> Result<WorkspaceReplacementPreviewPayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.workspace_root_path.clone()))?;
    let query = require_replacement_query(&payload.query)?;
    let limit = payload
        .limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_REPLACEMENT_FILE_LIMIT)
        .min(MAX_REPLACEMENT_FILE_LIMIT);
    let filters = build_path_filters(&payload.include_patterns, &payload.exclude_patterns)?;
    let files = scan_workspace_files(&workspace_root, &filters)?;

    let plan = build_replacement_plan(&payload, &query)?;
    let previews = build_replacement_previews(&workspace_root, &files, &payload, &plan, limit)?;
    build_replacement_preview_payload(workspace_root, previews)
}

#[tauri::command]
#[specta::specta]
pub fn apply_workspace_replacement(
    payload: WorkspaceReplacementApplyRequest,
) -> Result<WorkspaceReplacementApplyPayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.request.workspace_root_path.clone()))?;
    let query = require_replacement_query(&payload.request.query)?;
    if payload.expected_files.is_empty() {
        return Err("替换预览已失效，请重新生成预览后再应用。".to_string());
    }

    let mut expected_paths = HashSet::new();
    let mut expected_hashes = HashMap::new();
    let mut expected_included_match_ids = HashMap::new();
    for expected_file in payload.expected_files {
        let file_path = resolve_existing_workspace_file(&workspace_root, &expected_file.path)?;
        if !expected_paths.insert(file_path.clone()) {
            continue;
        }
        expected_included_match_ids.insert(file_path.clone(), expected_file.included_match_ids);
        expected_hashes.insert(file_path, expected_file.before_hash);
    }

    let plan = build_replacement_plan(&payload.request, &query)?;
    let mut applied_files = Vec::new();
    let mut replacement_count = 0usize;
    for file_path in expected_paths {
        let file = scanned_file_from_path(&workspace_root, file_path)?;
        let Some(replacement) =
            build_file_replacement_preview(&workspace_root, &file, &payload.request, &plan)?
        else {
            return Err(format!(
                "文件 {} 已不再命中当前替换规则，请重新生成预览。",
                file.relative_path
            ));
        };

        let expected_hash = expected_hashes
            .get(&file.path)
            .ok_or_else(|| "替换预览状态不完整，请重新生成预览后再应用。".to_string())?;
        if replacement.before_hash != *expected_hash {
            return Err(format!(
                "文件 {} 在预览后已变更，请重新生成预览。",
                replacement.relative_path
            ));
        }

        let included_match_ids = expected_included_match_ids
            .get(&file.path)
            .ok_or_else(|| "替换预览状态不完整，请重新生成预览后再应用。".to_string())?;
        let selected_edits = select_replacement_edits(&replacement, included_match_ids)?;
        if selected_edits.is_empty() {
            continue;
        }
        let after_content = apply_replacement_edits(&replacement.before_content, &selected_edits);
        let selected_replacement_count = selected_edits.len();

        let bytes = encode_script_content(&after_content, &replacement.encoding)
            .map_err(|error| format!("编码替换结果失败({}): {error}", replacement.relative_path))?;
        fs::write(&replacement.path, bytes)
            .map_err(|error| format!("写入替换结果失败({}): {error}", replacement.relative_path))?;
        let byte_size = fs::metadata(&replacement.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        replacement_count += selected_replacement_count;
        applied_files.push(WorkspaceReplacementAppliedFile {
            path: replacement.path.to_string_lossy().to_string(),
            relative_path: replacement.relative_path,
            replacement_count: count_to_u32(selected_replacement_count, "替换数量")?,
            byte_size: u64_to_u32(byte_size, "文件字节数")?,
        });
    }

    applied_files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(WorkspaceReplacementApplyPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        changed_file_count: count_to_u32(applied_files.len(), "变更文件数")?,
        replacement_count: count_to_u32(replacement_count, "替换数量")?,
        files: applied_files,
    })
}

#[cfg(test)]
mod tests {
    use super::scan::WORKSPACE_FILE_CACHES;
    use super::*;
    use std::{
        env, fs,
        path::{Path, PathBuf},
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_workspace(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("系统时间应晚于 Unix epoch")
            .as_nanos();
        let root =
            env::temp_dir().join(format!("calamex-search-{name}-{}-{suffix}", process::id()));
        fs::create_dir_all(&root).expect("应能创建测试工作区");
        root.canonicalize().expect("应能解析测试工作区")
    }

    fn write_workspace_file(root: &Path, relative_path: &str, content: &str) -> PathBuf {
        let path = root.join(relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("应能创建测试目录");
        }
        fs::write(&path, content.as_bytes()).expect("应能写入测试文件");
        path.canonicalize().expect("应能解析测试文件")
    }

    fn replacement_request(
        root: &Path,
        query: &str,
        replacement: &str,
        use_regex: bool,
        use_structural: bool,
    ) -> WorkspaceReplacementRequest {
        WorkspaceReplacementRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: query.to_string(),
            replacement: replacement.to_string(),
            match_case: true,
            whole_word: false,
            use_regex,
            use_structural,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        }
    }

    fn expected_files(
        preview: &WorkspaceReplacementPreviewPayload,
    ) -> Vec<WorkspaceReplacementExpectedFile> {
        preview
            .files
            .iter()
            .map(|file| WorkspaceReplacementExpectedFile {
                path: file.path.clone(),
                before_hash: file.before_hash.clone(),
                included_match_ids: Vec::new(),
            })
            .collect()
    }

    fn cleanup_workspace(root: PathBuf) {
        if let Some(caches) = WORKSPACE_FILE_CACHES.get()
            && let Ok(mut guard) = caches.lock()
        {
            guard.remove(&root.to_string_lossy().to_string());
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plain_replacement_keeps_dollar_literal() {
        let root = temp_workspace("plain");
        let file = write_workspace_file(&root, "script.sh", "echo \"$HOME\"\necho \"$HOME\"\n");
        let request = replacement_request(&root, "$HOME", "$PATH", false, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        assert_eq!(preview.file_count, 1);
        assert_eq!(preview.replacement_count, 2);
        assert!(preview.files[0].diff.contains("$PATH"));

        let expected_files = expected_files(&preview);
        let applied = apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        })
        .expect("应能应用替换");
        assert_eq!(applied.changed_file_count, 1);
        assert_eq!(applied.replacement_count, 2);
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo \"$PATH\"\necho \"$PATH\"\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn regex_replacement_expands_capture_groups() {
        let root = temp_workspace("regex");
        let file = write_workspace_file(&root, "script.sh", "echo foo-12\necho foo-34\n");
        let request = replacement_request(&root, r"foo-(\d+)", "bar-$1", true, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成正则替换预览");
        assert_eq!(preview.file_count, 1);
        assert_eq!(preview.replacement_count, 2);
        assert_eq!(preview.files[0].line_previews.len(), 2);
        assert_eq!(preview.files[0].line_previews[0].before_line, "echo foo-12");
        assert_eq!(preview.files[0].line_previews[0].after_line, "echo bar-12");

        let expected_files = expected_files(&preview);
        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        })
        .expect("应能应用正则替换");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo bar-12\necho bar-34\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn replacement_preview_keeps_matches_on_same_line_separate() {
        let root = temp_workspace("same-line-preview");
        let file = write_workspace_file(&root, "script.sh", "echo old old\n");
        let request = replacement_request(&root, "old", "new", false, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        let line_previews = &preview.files[0].line_previews;
        assert_eq!(preview.replacement_count, 2);
        assert_eq!(line_previews.len(), 2);
        assert_eq!(line_previews[0].replacement_count, 1);
        assert_eq!(line_previews[1].replacement_count, 1);
        assert_ne!(line_previews[0].id, line_previews[1].id);
        assert_eq!(line_previews[0].before_line, "echo old old");
        assert_eq!(line_previews[0].after_line, "echo new old");
        assert_eq!(line_previews[1].before_line, "echo old old");
        assert_eq!(line_previews[1].after_line, "echo old new");

        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files: vec![WorkspaceReplacementExpectedFile {
                path: preview.files[0].path.clone(),
                before_hash: preview.files[0].before_hash.clone(),
                included_match_ids: vec![line_previews[0].id.clone()],
            }],
        })
        .expect("应能只替换同一行中的单个命中");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo new old\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn replacement_can_apply_single_preview_line() {
        let root = temp_workspace("single-line");
        let file = write_workspace_file(&root, "script.sh", "echo old\necho old\n");
        let request = replacement_request(&root, "old", "new", false, false);

        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        let first_line = preview.files[0].line_previews[0].id.clone();
        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files: vec![WorkspaceReplacementExpectedFile {
                path: preview.files[0].path.clone(),
                before_hash: preview.files[0].before_hash.clone(),
                included_match_ids: vec![first_line],
            }],
        })
        .expect("应能只应用单行替换");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "echo new\necho old\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn content_search_returns_each_match_on_same_line() {
        let root = temp_workspace("same-line-search");
        write_workspace_file(&root, "script.sh", "echo needle needle\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "needle".to_string(),
            scope: WorkspaceSearchScope::Content,
            match_case: true,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能搜索工作区");

        assert_eq!(payload.results.len(), 2);
        assert_eq!(payload.results[0].line_number, Some(1));
        assert_eq!(payload.results[0].match_start, Some(5));
        assert_eq!(payload.results[0].match_end, Some(11));
        assert_eq!(payload.results[1].line_number, Some(1));
        assert_eq!(payload.results[1].match_start, Some(12));
        assert_eq!(payload.results[1].match_end, Some(18));

        cleanup_workspace(root);
    }

    #[test]
    fn structural_search_returns_match_range_for_compact_preview() {
        let root = temp_workspace("structural-range");
        write_workspace_file(&root, "script.sh", "prefix\nfoo 123\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "foo $A".to_string(),
            scope: WorkspaceSearchScope::Content,
            match_case: true,
            whole_word: false,
            use_regex: false,
            use_structural: true,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能执行结构化搜索");

        assert_eq!(payload.results.len(), 1);
        assert_eq!(payload.results[0].line_number, Some(2));
        assert_eq!(payload.results[0].line_text.as_deref(), Some("foo 123"));
        assert_eq!(payload.results[0].match_start, Some(0));
        assert_eq!(payload.results[0].match_end, Some(7));

        cleanup_workspace(root);
    }

    #[test]
    fn search_skips_git_objects_and_binary_assets_from_source() {
        let root = temp_workspace("skip-binary");
        write_workspace_file(&root, ".git/objects/16/hash", "needle\n");
        write_workspace_file(&root, "asset.png", "needle\n");
        let script = write_workspace_file(&root, "script.sh", "needle\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "needle".to_string(),
            scope: WorkspaceSearchScope::All,
            match_case: true,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能搜索工作区");

        assert!(
            payload
                .results
                .iter()
                .any(|result| result.path == script.to_string_lossy())
        );
        assert!(
            !payload
                .results
                .iter()
                .any(|result| result.relative_path.starts_with(".git/"))
        );
        assert!(
            !payload
                .results
                .iter()
                .any(|result| result.relative_path == "asset.png")
        );

        cleanup_workspace(root);
    }

    #[test]
    fn structural_replacement_uses_bash_ast_grep() {
        let root = temp_workspace("structural");
        let file = write_workspace_file(&root, "script.sh", "foo 1\nfoo 2\nbar 3\n");
        let request = replacement_request(&root, "foo $A", "baz $A", false, true);

        let preview =
            preview_workspace_replacement(request.clone()).expect("应能生成结构化替换预览");
        assert_eq!(preview.file_count, 1);
        assert_eq!(preview.replacement_count, 2);

        let expected_files = expected_files(&preview);
        apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        })
        .expect("应能应用结构化替换");
        assert_eq!(
            fs::read_to_string(file).expect("应能读取替换后的文件"),
            "baz 1\nbaz 2\nbar 3\n"
        );

        cleanup_workspace(root);
    }

    #[test]
    fn apply_replacement_rejects_changed_file_after_preview() {
        let root = temp_workspace("hash");
        let file = write_workspace_file(&root, "script.sh", "echo old\n");
        let request = replacement_request(&root, "old", "new", false, false);
        let preview = preview_workspace_replacement(request.clone()).expect("应能生成替换预览");
        let expected_files = expected_files(&preview);

        fs::write(&file, b"echo old\n# changed\n").expect("应能模拟预览后的文件变更");
        let error = match apply_workspace_replacement(WorkspaceReplacementApplyRequest {
            request,
            expected_files,
        }) {
            Ok(_) => panic!("文件变更后应拒绝应用旧预览"),
            Err(error) => error,
        };
        assert!(error.contains("已变更"));

        cleanup_workspace(root);
    }

    #[test]
    fn symbol_search_returns_function_definitions() {
        let root = temp_workspace("symbol");
        write_workspace_file(&root, "script.sh", "deploy_app() {\n    echo deploy\n}\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "deploy_app".to_string(),
            scope: WorkspaceSearchScope::Symbol,
            match_case: false,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(20),
        })
        .expect("应能执行符号搜索");

        assert!(payload.results.iter().any(|result| {
            matches!(result.kind, WorkspaceSearchResultKind::Symbol)
                && result.name == "deploy_app"
                && result.line_number == Some(1)
        }));

        cleanup_workspace(root);
    }

    #[test]
    fn all_scope_keeps_content_results_when_file_name_matches_fill_limit() {
        let root = temp_workspace("all-scope-limit");
        write_workspace_file(&root, "needle_a.txt", "alpha\n");
        write_workspace_file(&root, "needle_b.txt", "beta\n");
        write_workspace_file(&root, "needle_c.txt", "gamma\n");
        let content_file = write_workspace_file(&root, "content.sh", "echo needle\n");

        let payload = search_workspace(WorkspaceSearchRequest {
            workspace_root_path: root.to_string_lossy().to_string(),
            query: "needle".to_string(),
            scope: WorkspaceSearchScope::All,
            match_case: false,
            whole_word: false,
            use_regex: false,
            use_structural: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
            limit: Some(2),
        })
        .expect("应能执行全部范围搜索");

        // 文件名命中已占满 limit=2，但 all 范围下内容结果仍应保留（修复前会被整体截断丢掉）。
        assert!(payload.results.iter().any(|result| {
            matches!(result.kind, WorkspaceSearchResultKind::Content)
                && result.path == content_file.to_string_lossy()
        }));

        cleanup_workspace(root);
    }
}
