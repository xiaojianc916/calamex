mod content_index;
mod find;
mod preview;
mod ranking;
mod replace;
mod scan;
mod stream;
mod types;
mod util;

pub use types::*;

use super::{encode_script_content, resolve_workspace_root};
use content_index::{filter_literal_content_candidates, prewarm_workspace_content_index};
use find::{search_file_contents, search_file_names, search_structural_contents, search_symbols};
use fs_err as fs;
use ranking::sort_ranked_search_results;
use replace::{
    apply_replacement_edits, build_file_replacement_preview, build_replacement_plan,
    build_replacement_preview_payload, build_replacement_previews, select_replacement_edits,
};
use scan::{
    build_path_filters, resolve_existing_workspace_file, scan_workspace_files,
    scanned_file_from_path,
};
use std::collections::{HashMap, HashSet};
use stream::{ContentBatchSink, SearchStreamSink};
use tauri::AppHandle;
use util::{count_to_u32, require_replacement_query, u64_to_u32};

const DEFAULT_SEARCH_LIMIT: usize = 200;
// 内容命中是逐行计数而非逐文件，单个超大文件（如 Cargo.lock）可能产生上万条命中。
// 配合 find::merge_per_file_results 的轮转合并，将上限抬高到 50000，让常规查询不再被截断，
// 前端再以虚拟列表 + 惰性高亮承接渲染。
const MAX_SEARCH_LIMIT: usize = 50000;
const DEFAULT_REPLACEMENT_FILE_LIMIT: usize = 100;
const MAX_REPLACEMENT_FILE_LIMIT: usize = 500;

#[tauri::command]
#[specta::specta]
pub async fn search_workspace(
    app: AppHandle,
    payload: WorkspaceSearchRequest,
) -> Result<WorkspaceSearchPayload, String> {
    // 同步命令会占满 Tauri 主线程：内容搜索期间通过 workspace-search-stream emit 的批次事件
    // 需经主线程事件循环投递给 webview，主线程被搜索阻塞时这些事件只能排队，直到命令 return
    // 后才一次性涌出（表现为「全部搜完才显示」，流式改造毫无可见效果）。
    // 改为异步命令 + spawn_blocking：把阻塞搜索（含 rayon 并行扫描）放到阻塞线程池执行，
    // 主线程事件循环保持空闲，从而能在搜索进行中实时投递流式批次事件，实现真正的「边搜边出」。
    tauri::async_runtime::spawn_blocking(move || {
        // 仅当前端带上 streamToken 时才建立流式推送；search_id 让前端把分批事件对应到本次请求。
        let stream = payload.stream_token.map(|search_id| (&app, search_id));
        search_workspace_impl(payload, stream)
    })
    .await
    .map_err(|error| format!("搜索任务执行失败：{error}"))?
}

fn search_workspace_impl(
    payload: WorkspaceSearchRequest,
    stream: Option<(&AppHandle, u32)>,
) -> Result<WorkspaceSearchPayload, String> {
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
            // 结构化内容搜索保持一次性返回（AST 解析通常很快，且非本次流式收益重点）。
            results.extend(search_structural_contents(&files, &query, content_limit)?);
        } else {
            // 普通内容搜索是最慢、收益最大的路径：带上 sink 时按文件发现顺序分批流式推送，
            // 命令仍返回全局最终排序结果（前端在 resolve 后整体替换流式列表）。
            let sink = stream.map(|(app, search_id)| {
                SearchStreamSink::new(
                    app,
                    search_id,
                    workspace_root.to_string_lossy().to_string(),
                    MAX_SEARCH_LIMIT,
                )
            });
            let indexed_content_candidates = filter_literal_content_candidates(
                &workspace_root,
                files.as_ref(),
                &query,
                &payload,
            )?;
            let content_files = indexed_content_candidates
                .as_deref()
                .unwrap_or_else(|| files.as_ref());

            results.extend(search_file_contents(
                content_files,
                &query,
                &payload,
                content_limit,
                sink.as_ref().map(|sink| sink as &dyn ContentBatchSink),
            )?);
            if let Some(sink) = sink.as_ref() {
                sink.finish();
            }
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

    // 轻量混合排序：各搜索器仍使用自己的高性能候选生成与 top-k，最终合并时再加入
    // kind / basename exact / prefix / path depth 等 IDE 常用排序特征。all 范围下仍不跨类别
    // 截断到单个 limit，避免文件名命中占满名额后挤掉内容/符号结果。
    sort_ranked_search_results(&mut results, &query, payload.match_case);

    // all 范围会把文件名/内容/符号三类命中各自取到 limit，合并后总量最多可达约 3×limit。
    // 排序后给单次响应设一个总量上限，避免极端 limit 下回传给前端的负载膨胀（前端按相同上限消费）。
    // 注意：这里不能截断到 limit —— all 范围下文件名命中常会占满 limit，截断到 limit 会把内容/
    // 符号结果整体挤掉（见 all_scope_keeps_content_results_when_file_name_matches_fill_limit）。
    if results.len() > MAX_SEARCH_LIMIT {
        results.truncate(MAX_SEARCH_LIMIT);
    }

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

/// 在工作区打开时后台预热搜索索引：提前建立文件清单缓存（含变更监听）与 Bash 符号索引，
/// 让用户首次在侧边栏「搜索」输入时省去全量目录遍历 / tree-sitter 解析的冷启动开销。
///
/// 完全在后台线程执行且吞掉所有错误：预热是纯优化，失败时下一次真正搜索会照常按需构建，
/// 不影响工作区打开流程或向用户报错。通过 resolve_workspace_root 复用与 search_workspace
/// 完全一致的根解析逻辑，确保预热写入的缓存键与后续搜索查找的键完全一致。
pub fn prewarm_workspace_search_index(workspace_root_path: String) {
    std::thread::Builder::new()
        .name("search-index-prewarm".into())
        .spawn(move || {
            let Ok(workspace_root) = resolve_workspace_root(Some(workspace_root_path)) else {
                return;
            };

            // 空规则（无 include/exclude）：预热整份文件清单缓存，并顺带安装搜索专用的递归变更监听。
            let Ok(filters) = build_path_filters(&[], &[]) else {
                return;
            };
            if scan_workspace_files(&workspace_root, &filters).is_err() {
                return;
            }

            // 预热 Bash 符号索引，让首个符号 / 全部范围搜索免去全量 tree-sitter 解析。
            let _ = scan::workspace_cache_symbols(&workspace_root);
            prewarm_workspace_content_index(&workspace_root);
        })
        .ok();
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
        assert_eq!(preview.files[0].line_previews[0].inserted_text, "bar-12");
        assert_eq!(preview.files[0].line_previews[0].match_start, 5);
        assert_eq!(preview.files[0].line_previews[0].match_end, 11);

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
        assert_eq!(line_previews[0].inserted_text, "new");
        assert_eq!(line_previews[0].match_start, 5);
        assert_eq!(line_previews[0].match_end, 8);
        assert_eq!(line_previews[1].before_line, "echo old old");
        assert_eq!(line_previews[1].inserted_text, "new");
        assert_eq!(line_previews[1].match_start, 9);
        assert_eq!(line_previews[1].match_end, 12);

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

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "needle".to_string(),
                scope: WorkspaceSearchScope::Content,
                match_case: true,
                whole_word: false,
                use_regex: false,
                use_structural: false,
                content_fuzzy: false,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(20),
                stream_token: None,
            },
            None,
        )
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

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "foo $A".to_string(),
                scope: WorkspaceSearchScope::Content,
                match_case: true,
                whole_word: false,
                use_regex: false,
                use_structural: true,
                content_fuzzy: false,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(20),
                stream_token: None,
            },
            None,
        )
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

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "needle".to_string(),
                scope: WorkspaceSearchScope::All,
                match_case: true,
                whole_word: false,
                use_regex: false,
                use_structural: false,
                content_fuzzy: false,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(20),
                stream_token: None,
            },
            None,
        )
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
        write_workspace_file(&root, "script.sh", "deploy_app() {\n echo deploy\n}\n");

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "deploy_app".to_string(),
                scope: WorkspaceSearchScope::Symbol,
                match_case: false,
                whole_word: false,
                use_regex: false,
                use_structural: false,
                content_fuzzy: false,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(20),
                stream_token: None,
            },
            None,
        )
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

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "needle".to_string(),
                scope: WorkspaceSearchScope::All,
                match_case: false,
                whole_word: false,
                use_regex: false,
                use_structural: false,
                content_fuzzy: false,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(2),
                stream_token: None,
            },
            None,
        )
        .expect("应能执行全部范围搜索");

        assert!(payload.results.iter().any(|result| {
            matches!(result.kind, WorkspaceSearchResultKind::Content)
                && result.path == content_file.to_string_lossy()
        }));

        cleanup_workspace(root);
    }

    #[test]
    fn fuzzy_content_search_matches_subsequence_and_returns_range() {
        let root = temp_workspace("fuzzy-content");
        write_workspace_file(&root, "script.sh", "echo deploy_app_now\n");

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "dapnow".to_string(),
                scope: WorkspaceSearchScope::Content,
                match_case: false,
                whole_word: false,
                use_regex: false,
                use_structural: false,
                content_fuzzy: true,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(20),
                stream_token: None,
            },
            None,
        )
        .expect("应能执行模糊内容搜索");

        assert_eq!(payload.results.len(), 1);
        let result = &payload.results[0];
        assert!(matches!(result.kind, WorkspaceSearchResultKind::Content));
        assert_eq!(result.line_number, Some(1));

        let match_start = result.match_start.expect("模糊命中应返回起始列");
        let match_end = result.match_end.expect("模糊命中应返回结束列");
        assert!(match_start < match_end);

        cleanup_workspace(root);
    }

    #[test]
    fn exact_content_search_ignores_fuzzy_subsequence() {
        let root = temp_workspace("exact-no-fuzzy");
        write_workspace_file(&root, "script.sh", "echo deploy_app_now\n");

        let payload = search_workspace_impl(
            WorkspaceSearchRequest {
                workspace_root_path: root.to_string_lossy().to_string(),
                query: "dapnow".to_string(),
                scope: WorkspaceSearchScope::Content,
                match_case: false,
                whole_word: false,
                use_regex: false,
                use_structural: false,
                content_fuzzy: false,
                include_patterns: Vec::new(),
                exclude_patterns: Vec::new(),
                limit: Some(20),
                stream_token: None,
            },
            None,
        )
        .expect("应能执行精确内容搜索");

        assert!(payload.results.is_empty());
        cleanup_workspace(root);
    }
}
