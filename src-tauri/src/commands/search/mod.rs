mod content_cache;
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
            results.extend(search_structural_contents(&workspace_root, &files, &query, content_limit)?);
        } else {
            // 普通内容搜索是最慢、收益最大的路径：带上 sink 时按文件发现顺序分批流式推送，
            // 命令仍返回全局最终排序结果（前端在 resolve 后整体替换流式列表）。
            let sink = stream.map(|(app, search_id)| {
                SearchStreamSink::new(
                    app,
                    search_id,
                    workspace_root.