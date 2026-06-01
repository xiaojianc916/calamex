use super::*;
use super::cli;
use crate::commands::workspace_fs::workspace_name;

#[tauri::command]
pub fn get_git_repository_status(
    workspace_root_path: Option<String>,
) -> Result<GitRepositoryStatusPayload, String> {
    let workspace_root = resolve_git_workspace_root(workspace_root_path)?;
    match gix::discover(&workspace_root) {
        Ok(repository) => build_git_repository_status_payload(&repository),
        Err(_) => Ok(build_unavailable_git_status("当前工作区未检测到 Git 仓库。")),
    }
}

#[tauri::command]
pub fn init_git_repository(
    workspace_root_path: Option<String>,
) -> Result<GitRepositoryStatusPayload, String> {
    let workspace_root = resolve_git_workspace_root(workspace_root_path)?;
    match gix::open(&workspace_root) {
        Ok(repository) => build_git_repository_status_payload(&repository),
        Err(_) => {
            gix::init(&workspace_root).map_err(|e| format!("初始化 Git 仓库失败：{e}"))?;
            let repository = gix::open(&workspace_root).map_err(|e| format!("读取初始化后的 Git 仓库失败：{e}"))?;
            build_git_repository_status_payload(&repository)
        }
    }
}

#[tauri::command]
pub fn get_git_file_baseline(path: String) -> Result<GitFileBaselinePayload, String> {
    let file_path = normalize_path_for_git(Path::new(&path));
    let discovery_root = file_path.parent().unwrap_or(file_path.as_path());
    match gix::discover(discovery_root) {
        Ok(repository) => build_git_file_baseline_payload(&repository, &file_path),
        Err(_) => Ok(GitFileBaselinePayload {
            available: false, message: Some("当前文件不在 Git 仓库中。".into()),
            repository_root_path: None, file_path: path, relative_path: None,
            is_tracked: false, content: None,
        }),
    }
}

#[tauri::command]
pub fn stage_git_paths(payload: GitPathOperationRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() { return build_git_repository_status_payload(&repository); }
    let mut arg_list = vec!["add", "--"];
    let ps_refs: Vec<&str> = pathspecs.iter().map(|s| s.as_str()).collect();
    arg_list.extend_from_slice(&ps_refs);
    cli::run_git_ok(&repository_root, &arg_list, "暂存文件")?;
    build_git_repository_status_payload(&repository)
}

#[tauri::command]
pub fn unstage_git_paths(payload: GitPathOperationRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() { return build_git_repository_status_payload(&repository); }
    let mut arg_list = vec!["reset", "-q", "--"];
    let ps_refs: Vec<&str> = pathspecs.iter().map(|s| s.as_str()).collect();
    arg_list.extend_from_slice(&ps_refs);
    cli::run_git_ok(&repository_root, &arg_list, "取消暂存")?;
    build_git_repository_status_payload(&repository)
}

#[tauri::command]
pub fn commit_git_index(payload: GitCommitRequest) -> Result<GitCommitResultPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    let message = payload.message.trim();
    if message.is_empty() { return Err("Git 提交说明不能为空。".into()); }
    let mut arg_list = vec!["commit", "-m", message];
    if !pathspecs.is_empty() {
        arg_list.push("--");
        let ps_refs: Vec<&str> = pathspecs.iter().map(|s| s.as_str()).collect();
        arg_list.extend_from_slice(&ps_refs);
    }
    cli::run_git_ok(&repository_root, &arg_list, "提交")?;
let repository = open_repository_from_root(&payload.repository_root_path)?;
let commit_id = resolve_head_commit(&repository).ok().flatten().map(|commit| commit.id().to_string());
let status = build_git_repository_status_payload(&repository)?;
Ok(GitCommitResultPayload { status, commit_id })
}

#[tauri::command]
pub fn discard_git_paths(payload: GitPathOperationRequest) -> Result<GitRepositoryStatusPayload, String> {
    let repository = open_repository_from_root(&payload.repository_root_path)?;
    let repository_root = resolve_repository_root(&repository)?;
    let pathspecs = resolve_pathspecs(&repository_root, &payload.paths)?;
    if pathspecs.is_empty() { return build_git_repository_status_payload(&repository); }
let mut tracked_pathspecs: Vec<String> = Vec::new();
for pathspec in &pathspecs {
    let relative_path = Path::new(pathspec);
    if is_tracked_git_path(&repository_root, relative_path)? {
        tracked_pathspecs.push(pathspec.clone());
    } else {
        // 未跟踪文件无法用 checkout 还原，直接从工作区删除。
        super::diff::remove_untracked_worktree_path(&repository_root, relative_path)?;
    }
}
if !tracked_pathspecs.is_empty() {
    let mut arg_list = vec!["checkout", "-q", "--"];
    let ps_refs: Vec<&str> = tracked_pathspecs.iter().map(|s| s.as_str()).collect();
    arg_list.extend_from_slice(&ps_refs);
    cli::run_git_ok(&repository_root, &arg_list, "放弃改动")?;
}
build_git_repository_status_payload(&repository)
}

/// 核心状态构建。
///
/// TODO(gix-status): gix 0.83 的 `index_worktree::Item` API 尚无稳定的 `.status()` 方法，
/// 与文档不符。待上游修复后迁移至 `repo.status()` 以消除 porcelain v2 解析器。
/// 跟踪：https://github.com/Byron/gitoxide/issues（开 issue 后替换为具体链接）
pub(super) fn build_git_repository_status_payload(
    repository: &Repository,
) -> Result<GitRepositoryStatusPayload, String> {
    let repository_root = resolve_repository_root(repository)?;
    let status = build_git_status_via_cli(&repository_root)?;

    let last_commit = resolve_head_commit(repository).ok().flatten().map(|c| build_git_commit_summary(&c));

    Ok(GitRepositoryStatusPayload {
        available: true, message: None,
        repository_root_path: Some(repository_root.to_string_lossy().to_string()),
        repository_name: Some(workspace_name(&repository_root)),
        git_dir_path: Some(repository.git_dir().to_string_lossy().to_string()),
        head_branch_name: status.head_branch,
        head_short_name: status.head_short_name,
        head_short_oid: status.head_oid.as_deref().map(|oid| oid.chars().take(7).collect::<String>()),
        is_detached: status.detached,
        is_clean: status.staged_count == 0 && status.unstaged_count == 0 && status.untracked_count == 0,
        ahead: status.ahead, behind: status.behind,
        staged_count: status.staged_count, unstaged_count: status.unstaged_count,
        untracked_count: status.untracked_count, conflicted_count: status.conflicted_count,
        files: status.files,
        last_commit,
    })
}

struct StatusAccum {
    head_branch: Option<String>,
    head_short_name: Option<String>,
    head_oid: Option<String>,
    detached: bool,
    ahead: usize,
    behind: usize,
    staged_count: usize,
    unstaged_count: usize,
    untracked_count: usize,
    conflicted_count: usize,
    files: Vec<GitFileStatusPayload>,
}

/// CLI porcelain v2 回退路径。
fn build_git_status_via_cli(repository_root: &Path) -> Result<StatusAccum, String> {
    let output = cli::run_git_text(
    repository_root,
    &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules", "-z"],
    "读取状态",
)?;

parse_git_status_v2(&output, repository_root)
}

fn parse_git_status_v2(output: &str, repository_root: &Path) -> Result<StatusAccum, String> {
    let mut accum = StatusAccum {
        head_branch: None, head_short_name: None, head_oid: None, detached: false,
        ahead: 0, behind: 0,
        staged_count: 0, unstaged_count: 0, untracked_count: 0, conflicted_count: 0,
        files: Vec::new(),
    };

    let tokens: Vec<&str> = output.split('\0').collect();
    let mut cursor = 0;
    while cursor < tokens.len() {
        let line = tokens[cursor].trim();
        cursor += 1;
        if line.is_empty() { continue; }
        if let Some(rest) = line.strip_prefix("# branch.oid ") { accum.head_oid = Some(rest.to_string()); }
        else if let Some(rest) = line.strip_prefix("# branch.head ") {
            if rest == "(detached)" { accum.detached = true; }
            else { accum.head_branch = Some(rest.to_string()); accum.head_short_name = Some(rest.to_string()); }
        }
        else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            if let Some((a, b)) = rest.split_once(' ') {
                accum.ahead = a.strip_prefix('+').and_then(|s| s.parse().ok()).unwrap_or(0);
                accum.behind = b.strip_prefix('-').and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
        else if line.starts_with('#') { continue; }
        else if let Some(mut entry) = parse_git_status_entry(line, repository_root) {
            // porcelain v2 + -z 模式下，重命名/复制（type 2）的原始路径位于紧随其后的 NUL token。
            if line.starts_with('2') {
                if let Some(orig) = tokens.get(cursor) {
                    let orig = orig.trim();
                    if !orig.is_empty() {
                        let orig_path = Path::new(orig);
                        entry.previous_relative_path = Some(path_to_forward_slashes(orig_path));
                        entry.previous_path = Some(repository_root.join(orig_path).to_string_lossy().to_string());
                    }
                    cursor += 1;
                }
            }
            if entry.index_status.as_deref() == Some("conflicted") { accum.conflicted_count += 1; }
            else if entry.index_status.is_some() { accum.staged_count += 1; }
            if entry.worktree_status.is_some() { accum.unstaged_count += 1; }
            if entry.is_untracked { accum.untracked_count += 1; }
            accum.files.push(entry);
        }
    }
    Ok(accum)
}

fn parse_git_status_entry(line: &str, repository_root: &Path) -> Option<GitFileStatusPayload> {
    // porcelain v2 -z NUL分隔格式：
    //   ? <path>          → 未跟踪
    //   ! <path>          → 已忽略
    //   1 XY ... <path>   → 普通条目（XY 为 index / worktree 状态码）
    //   2 XY ... <path>   → 重命名 / 复制条目
    //   u XY ... <path>   → 未合并条目

    let first_char = line.chars().next()?;

    if first_char == '?' {
        let relative_path = Path::new(line[2..].trim());
        let rps = path_to_forward_slashes(relative_path);
        let file_name = relative_path.file_name().and_then(|v| v.to_str()).map(str::to_string).unwrap_or_else(|| rps.clone());
        return Some(GitFileStatusPayload {
            path: repository_root.join(relative_path).to_string_lossy().to_string(),
            relative_path: rps, file_name,
            previous_path: None, previous_relative_path: None,
            index_status: None, worktree_status: Some("untracked".to_string()),
            is_conflicted: false, is_untracked: true,
        });
    }

    if first_char == '!' {
        let relative_path = Path::new(line[2..].trim());
        let rps = path_to_forward_slashes(relative_path);
        let file_name = relative_path.file_name().and_then(|v| v.to_str()).map(str::to_string).unwrap_or_else(|| rps.clone());
        return Some(GitFileStatusPayload {
            path: repository_root.join(relative_path).to_string_lossy().to_string(),
            relative_path: rps, file_name,
            previous_path: None, previous_relative_path: None,
            index_status: None, worktree_status: Some("ignored".to_string()),
            is_conflicted: false, is_untracked: false,
        });
    }

    if first_char == '1' || first_char == '2' || first_char == 'u' {
        // 1 XY / 2 XY / u XY 格式：<prefix> <X><Y> <8个字段> <path>
        let rest = &line[2..]; // 跳过 prefix 和空格
        if rest.len() < 2 { return None; }
        let x = rest.chars().next()?;
        let y = rest.chars().nth(1)?;
        let is_conflict = first_char == 'u';

        let char_to_status = |c: char| -> Option<&str> {
            match c {
                'M' => Some("modified"),
                'A' => Some("added"),
                'D' => Some("deleted"),
                'R' => Some("renamed"),
                'C' => Some("copied"),
                'T' => Some("typechange"),
                'U' => Some("conflicted"),
                _ => None,
            }
        };

        let idx = if is_conflict { Some("conflicted") } else { char_to_status(x) };
        let wt  = if is_conflict { Some("conflicted") } else { char_to_status(y) };

        // 跳过 "XY " 和后续 8 个空格分隔的字段，从路径开始
        // 普通条目(1) 路径前有 6 个字段；重命名/复制(2) 多一个 <X><score> 共 7 个；未合并(u) 有 8 个。
        let after_fields = &rest[3..]; // 跳过 "XY "
        let field_count = match first_char { '2' => 7, 'u' => 8, _ => 6 };
        let path_start = after_fields
        .char_indices()
        .filter(|(_, ch)| *ch == ' ')
        .nth(field_count - 1)
        .map(|(i, _)| i + 1)
        .unwrap_or(0);
        let path_str = after_fields[path_start..].trim();
        if path_str.is_empty() { return None; }

        let relative_path = Path::new(path_str);
        let rps = path_to_forward_slashes(relative_path);
        let file_name = relative_path.file_name().and_then(|v| v.to_str()).map(str::to_string).unwrap_or_else(|| rps.clone());
        return Some(GitFileStatusPayload {
            path: repository_root.join(relative_path).to_string_lossy().to_string(),
            relative_path: rps, file_name,
            previous_path: None, previous_relative_path: None,
            index_status: idx.map(str::to_string),
            worktree_status: wt.map(str::to_string),
            is_conflicted: is_conflict,
            is_untracked: false,
        });
    }

    None
}


fn build_unavailable_git_status(message: &str) -> GitRepositoryStatusPayload {
    GitRepositoryStatusPayload {
        available: false, message: Some(message.into()),
        repository_root_path: None, repository_name: None, git_dir_path: None,
        head_branch_name: None, head_short_name: None, head_short_oid: None,
        is_detached: false, is_clean: true,
        ahead: 0, behind: 0,
        staged_count: 0, unstaged_count: 0, untracked_count: 0, conflicted_count: 0,
        files: Vec::new(), last_commit: None,
    }
}

fn build_git_file_baseline_payload(repository: &Repository, file_path: &Path) -> Result<GitFileBaselinePayload, String> {
    let repository_root = resolve_repository_root(repository)?;
    let relative_path = resolve_relative_path(&repository_root, file_path)?;
    let relative_path_string = path_to_forward_slashes(&relative_path);
    let is_tracked = is_tracked_git_path(&repository_root, &relative_path)?;
    if !is_tracked {
        return Ok(GitFileBaselinePayload {
            available: true, message: Some("当前文件未被 Git 跟踪。".into()),
            repository_root_path: Some(repository_root.to_string_lossy().to_string()),
            file_path: file_path.to_string_lossy().to_string(),
            relative_path: Some(relative_path_string), is_tracked: false, content: None,
        });
    }
    let object_spec = format!("HEAD:{relative_path_string}");
    let content = read_git_revision_text(&repository_root, &object_spec)?;
    Ok(GitFileBaselinePayload {
        available: true,
        message: if content.is_none() { Some("当前文件基线不是可直接比较的文本内容。".into()) } else { None },
        repository_root_path: Some(repository_root.to_string_lossy().to_string()),
        file_path: file_path.to_string_lossy().to_string(),
        relative_path: Some(relative_path_string), is_tracked: true, content,
    })
}

pub(super) fn is_tracked_git_path(repository_root: &Path, relative_path: &Path) -> Result<bool, String> {
    let rp = path_to_forward_slashes(relative_path);
    match cli::run_git_text_allow_exit_one(repository_root, &["ls-files", "--error-unmatch", &rp], "检查跟踪") {
        Ok(Some(_)) => Ok(true),
        _ => Ok(false),
    }
}

pub(super) fn read_git_revision_text(repository_root: &Path, object_spec: &str) -> Result<Option<String>, String> {
    match cli::run_git_text_allow_exit_one(repository_root, &["cat-file", "-p", object_spec], "读取对象") {
        Ok(Some(content)) => {
            decode_script_bytes(content.as_bytes())
                .map(|(c, _)| Some(c))
                .map_err(|_| "当前对象不是可直接比较的文本内容。".to_string())
        }
        _ => Ok(None),
    }
}

