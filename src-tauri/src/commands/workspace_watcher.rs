//! 工作区文件系统监听
//!
//! ## 设计：按平台选择监听原语（关键）
//!
//! 冻结的真正元凶不是「递归监听」本身，而是 `notify-debouncer-full` 的 `FileIdMap`
//! 会在 `watch()` 时主动递归遍历整棵树登记 file-id。Windows(ReadDirectoryChangesW)
//! 与 macOS(FSEvents) 本身支持廉价的内核级递归监听，根本不需要为每个子目录单独加
//! watch，也不该承担 FileIdMap 那层用户态遍历。
//!
//! 因此本模块**不使用 debouncer-full**，直接用裸 `notify` watcher + 自实现去抖：
//! - **Windows / macOS**：对根目录做**单次递归监听**（内核级递归，近乎 O(1) 成本，
//!   无树遍历、无 watch 句柄爆炸、无「新建目录补监听」的竞态窗口）；忽略目录在事件层过滤。
//! - **Linux (inotify)**：inotify 无原生递归，会给每个子目录单独加 watch，故必须先用
//!   `ignore::WalkBuilder` 剪枝（跳过 node_modules / target / .git 内部高频目录…）再逐目录非递归监听，
//!   并在目录增删时动态跟进。
//!
//! ## 其它
//! - 自实现尾沿去抖：安静 `DEBOUNCE_DURATION` 后吐出一批；持续事件风暴下最多攒
//!   `MAX_DEBOUNCE` 强制吐出一次，避免饿死前端刷新。
//! - 遍历 + 监听 + 事件循环全部在后台线程执行，打开大仓库时绝不阻塞命令返回 / 冻结 UI。
//! - 同一时刻只有一个活跃监听；启动时若已有则「先建后换」，旧监听由原子标志位通知退出。
//! - 去抖后通过强类型 specta 事件 `workspace-fs-event` 推送到前端。

use arc_swap::ArcSwapOption;
use ignore::WalkBuilder;
use notify::{
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher, event::ModifyKind,
    recommended_watcher,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsStr,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError, channel},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use tauri_specta::Event as _;

/// 尾沿去抖的安静期：最后一条事件后再静默这么久，才把这一批吐给前端。
const DEBOUNCE_DURATION: Duration = Duration::from_millis(200);

/// 事件风暴下的强制吐出上限：即使事件持续不断，攒满这个时长也先吐一批，
/// 避免「构建/git 操作刷屏」时前端长时间收不到任何更新。
const MAX_DEBOUNCE: Duration = Duration::from_secs(1);

/// 当前平台是否提供廉价的内核级递归监听。
///
/// Windows(ReadDirectoryChangesW) / macOS(FSEvents) 为 true：单次递归监听即可。
/// Linux(inotify) 为 false：无原生递归，需剪枝后逐目录非递归监听并动态维护。
#[cfg(any(target_os = "windows", target_os = "macos"))]
const NATIVE_RECURSIVE: bool = true;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const NATIVE_RECURSIVE: bool = false;

/// 始终忽略的目录名（按目录名匹配，相对监听根的任意层级）。
///
/// 作为 `.gitignore` 之外的兜底黑名单：即便仓库没有写 .gitignore（或根本不是
/// git 仓库），这些目录在依赖安装 / 构建 / git 操作时也会喷出成千上万条无意义
/// 事件、灌满去抖窗口、拖垮前端刷新。语义对齐编辑器通行的 watcher 排除清单。
///
/// 注意：`.git` **不在**此整目录黑名单内——其内部高频目录另由
/// `IGNORED_GIT_INTERNAL_DIRS` 精细处理，从而放行 .git 顶层状态文件 / refs / logs，
/// 让外部 git commit / checkout / pull 能触发前端 git 面板刷新。
const IGNORED_DIR_NAMES: &[&str] = &[
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    ".next",
    ".nuxt",
    ".turbo",
    ".venv",
    "__pycache__",
];

// ============================================================================
// 事件负载
// ============================================================================

/// 单条文件系统变更
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    /// 变更路径的绝对路径（已 canonicalize；Windows 上不含 `\\?\` UNC 前缀）
    pub path: String,
    /// 事件类型
    pub kind: FsChangeKind,
}

/// 文件系统变更类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FsChangeKind {
    Created,
    Modified,
    Removed,
    Renamed,
}

/// 工作区文件系统事件
///
/// derive `tauri_specta::Event` 让此类型同时：
/// - 出现在生成的 TS 绑定 `events.workspaceFsEvent.listen(...)` 中
/// - 提供类型化的 `.emit(app)` 方法（事件名自动为 `workspace-fs-event`）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFsEvent {
    /// 本批次的变更列表
    ///
    /// 已按路径去重，同一路径保留 severity 最高的 kind
    /// (Removed > Renamed > Created > Modified)
    pub changes: Vec<FsChange>,
    /// 监听根目录的绝对路径
    pub root_path: String,
}

impl tauri_specta::Event for WorkspaceFsEvent {
    const NAME: &'static str = "workspace-fs-event";
}

// ============================================================================
// 监听状态容器
// ============================================================================

/// 单个活跃监听的句柄。
///
/// watcher 本体由后台线程持有（见 `run_watch_loop`），这里只保留通知其退出的
/// 原子标志位；置 true 后线程会在 `DEBOUNCE_DURATION` 内跳出循环并 Drop watcher。
struct WatcherState {
    stop: Arc<AtomicBool>,
    /// 监听的根目录（保留用于诊断）
    #[allow(dead_code)]
    root_path: PathBuf,
}

impl WatcherState {
    fn signal_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// 全局工作区监听器，保证同一时刻只有一个活跃 watcher
///
/// 使用 `ArcSwapOption` 支持热替换：先启动新监听线程，成功后再原子 swap，
/// 随后通知旧线程退出，避免 stop → start 中间的真空期。
///
/// 通过 `app.manage(WorkspaceWatcher::default())` 注册到 Tauri State。
#[derive(Default)]
pub struct WorkspaceWatcher(ArcSwapOption<WatcherState>);

// ============================================================================
// Tauri 命令
// ============================================================================

/// 启动（或重启）工作区文件监听
///
/// 真正的目录遍历与监听在后台线程完成，本命令仅做根目录校验与 watcher 构造后
/// 立即返回，因此打开超大仓库也不会阻塞前端。监听结果通过 `WorkspaceFsEvent` 推送。
/// 若已有监听，会先换入新句柄再通知旧线程退出，旧 watcher 在其线程结束时 Drop。
///
/// # 参数
/// - `root_path`: 工作区根目录的绝对或相对路径，会被 canonicalize
///
/// # 错误
/// 路径不存在 / 不是目录、或 watcher 构造失败时返回 `Err(String)`。
/// 注意：后台的实际 watch 调用失败只记日志，不再同步抛出（后台化的取舍）。
#[tauri::command]
#[specta::specta]
pub fn start_workspace_watching(
    app: AppHandle,
    state: tauri::State<'_, WorkspaceWatcher>,
    root_path: String,
) -> Result<(), String> {
    // 1. 解析 + 验证根目录
    //    std::fs::canonicalize 在 Windows 上返回普通路径，而非 \\?\ UNC
    let root = std::fs::canonicalize(&root_path)
        .map_err(|e| format!("无法解析工作区根目录 `{root_path}`：{e}"))?;
    if !root.is_dir() {
        return Err(format!("工作区根路径不是有效目录：{}", root.display()));
    }

    // 2. 构造裸 watcher（不使用 debouncer-full，避免 FileIdMap 的递归树遍历）。
    //    回调只把原始事件投递到 channel，去抖与处理全在后台线程完成。
    //    构造失败时不要触碰 state，旧监听（若有）保持不动。
    let (tx, rx) = channel::<notify::Result<Event>>();
    let watcher = recommended_watcher(move |result: notify::Result<Event>| {
        // 后台线程退出后 rx 被 Drop，send 失败可安全忽略。
        let _ = tx.send(result);
    })
    .map_err(|e| format!("创建文件监听器失败：{e}"))?;

    // 3. 后台启动：watch 配置 + 去抖 + 事件循环全部丢到独立线程，
    //    打开大仓库时绝不阻塞命令返回 / 冻结 UI。
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let worker_root = root.clone();
    thread::Builder::new()
        .name("workspace-watcher".into())
        .spawn(move || run_watch_loop(watcher, rx, app, worker_root, worker_stop))
        .map_err(|e| format!("启动文件监听线程失败：{e}"))?;

    // 4. 原子换入新句柄，并通知旧监听线程退出（先建后换，无监听真空期）。
    let new_state = Arc::new(WatcherState {
        stop,
        root_path: root.clone(),
    });
    if let Some(previous) = state.0.swap(Some(new_state)) {
        previous.signal_stop();
    }

    log::info!("工作区文件监听已请求启动: {}", root.display());
    Ok(())
}

/// 停止工作区文件监听
///
/// 通知后台线程退出；线程在 `DEBOUNCE_DURATION` 内跳出循环并 Drop watcher。
/// 重复调用、未启动时调用都是安全的（幂等）。
#[tauri::command]
#[specta::specta]
pub fn stop_workspace_watching(state: tauri::State<'_, WorkspaceWatcher>) -> Result<(), String> {
    if let Some(previous) = state.0.swap(None) {
        previous.signal_stop();
    }
    log::info!("工作区文件监听已停止");
    Ok(())
}

// ============================================================================
// 后台事件循环
// ============================================================================

/// 后台线程主体：先按平台挂好监听，随后循环消费事件、做尾沿去抖直到收到停止信号。
fn run_watch_loop(
    mut watcher: RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
    app: AppHandle,
    root: PathBuf,
    stop: Arc<AtomicBool>,
) {
    setup_initial_watches(&mut watcher, &root);

    // 自实现尾沿去抖：攒到一批事件，安静 DEBOUNCE_DURATION 或攒满 MAX_DEBOUNCE 后吐出。
    // 在线聚合：事件一到就按 path 折叠进 HashMap（只留最高 severity 的 kind），而非先攒
    // 原始 Vec<Event> 到 flush 才去重。事件风暴下内存从 O(原始事件数) 降到 O(唯一路径数)。
    let mut pending: HashMap<String, FsChangeKind> = HashMap::new();
    let mut first_at: Option<Instant> = None;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match rx.recv_timeout(DEBOUNCE_DURATION) {
            Ok(Ok(event)) => {
                // Linux 非递归监听需自行跟进目录增删；Win/Mac 递归监听无需。
                if !NATIVE_RECURSIVE {
                    maintain_watches(&mut watcher, &root, &event);
                }
                ingest_event(&mut pending, &root, &event);
                // 整批都是被忽略的噪音（构建/依赖/.git objects 等）时不开窗，避免空 flush。
                if pending.is_empty() {
                    continue;
                }
                if first_at.is_none() {
                    first_at = Some(Instant::now());
                }
                // 事件风暴下的强制上限：攒太久也要吐一次，避免饿死前端刷新。
                if first_at.is_some_and(|t| t.elapsed() >= MAX_DEBOUNCE) {
                    flush_events(&mut pending, &app, &root);
                    first_at = None;
                }
            }
            Ok(Err(e)) => log::warn!("文件监听产生错误事件: {e}"),
            // 安静期已到（尾沿去抖）：把这一批攒下的事件吐给前端。
            Err(RecvTimeoutError::Timeout) => {
                if !pending.is_empty() {
                    flush_events(&mut pending, &app, &root);
                    first_at = None;
                }
            }
            // 仅当 watcher（持有 Sender）被 Drop 时发生；正常路径走 stop 标志。
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // 退出前把残留事件吐完，避免丢最后一批。
    if !pending.is_empty() {
        flush_events(&mut pending, &app, &root);
    }
    // watcher 在此 Drop，底层监听关闭、内部线程回收。
    log::info!("工作区文件监听线程已退出: {}", root.display());
}

/// 按平台挂好初始监听。
fn setup_initial_watches(watcher: &mut RecommendedWatcher, root: &Path) {
    if NATIVE_RECURSIVE {
        // Win/Mac：单次内核级递归监听，廉价且无需逐目录维护。
        match watcher.watch(root, RecursiveMode::Recursive) {
            Ok(()) => log::info!("工作区文件监听已就绪（递归）: {}", root.display()),
            Err(e) => log::warn!("递归监听根目录失败 {}: {e}", root.display()),
        }
    } else {
        // Linux：剪枝遍历后逐目录非递归监听。
        let mut watched = 0usize;
        for dir in collect_watch_dirs(root) {
            match watcher.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => watched += 1,
                Err(e) => log::warn!("监听目录失败 {}: {e}", dir.display()),
            }
        }
        log::info!(
            "工作区文件监听已就绪：{watched} 个目录（根 {}）",
            root.display()
        );
    }
}

/// 仅 Linux 非递归监听使用：根据事件动态维护监听集合。
///
/// - 新建目录：剪枝子遍历后补挂监听，覆盖「mkdir -p a/b/c」「git checkout 拉出整棵新目录」等；
/// - 删除目录：best-effort 解除监听（删的是文件时 unwatch 失败，忽略即可）。
fn maintain_watches(watcher: &mut RecommendedWatcher, root: &Path, event: &Event) {
    match &event.kind {
        EventKind::Create(_) => {
            for path in &event.paths {
                if path.is_dir() && !is_ignored_change(root, path) {
                    for dir in collect_watch_dirs(path) {
                        let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
                    }
                }
            }
        }
        EventKind::Remove(_) => {
            for path in &event.paths {
                let _ = watcher.unwatch(path);
            }
        }
        _ => {}
    }
}

// ============================================================================
// 目录剪枝遍历（Linux 逐目录监听用）
// ============================================================================

/// 在 `start` 子树内做「剪枝遍历」，返回所有需要监听的目录（含 `start` 本身）。
///
/// 剪枝规则（与编辑器通行做法对齐）：
/// - 尊重 `.gitignore` / `.ignore` / 全局 gitignore / `.git/info/exclude`
///   （由 ignore crate 处理；`parents(true)` 让子树遍历也能读到祖先的忽略规则）；
/// - 叠加固定黑名单 `IGNORED_DIR_NAMES` 作为兜底：即便仓库没写 .gitignore，
///   node_modules / target 等也绝不进入；
/// - 对 `.git`：本体（及 refs/logs 等状态目录）保留监听，仅剪掉 `objects` 等
///   `IGNORED_GIT_INTERNAL_DIRS` 高频内部目录，避免 commit/gc 刷屏又不漏掉状态变更；
/// - 隐藏目录不一刀切跳过（`hidden(false)`），交给上面几条规则决定，
///   这样 .vscode 等用户关心的隐藏目录仍可被监听。
fn collect_watch_dirs(start: &Path) -> Vec<PathBuf> {
    let walker = WalkBuilder::new(start)
        .hidden(false)
        .parents(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .filter_entry(|entry| {
            // 根（depth==0）永不剪掉；只对子目录套用固定黑名单。
            if entry.depth() == 0 {
                return true;
            }
            if !entry.file_type().is_some_and(|ft| ft.is_dir()) {
                return true;
            }
            let Some(name) = entry.file_name().to_str() else {
                return true;
            };
            if is_ignored_dir_name(name) {
                return false;
            }
            // .git 内部仅保留 refs/logs 等状态目录，剪掉 objects 等高频目录：
            // 让外部 git 操作写入的引用/日志能触发监听，又不被对象库刷屏。
            if IGNORED_GIT_INTERNAL_DIRS
                .iter()
                .any(|dir| os_str_eq(OsStr::new(name), OsStr::new(dir)))
                && entry.path().components().any(|component| {
                    matches!(component, Component::Normal(n) if os_str_eq(n, OsStr::new(".git")))
                })
            {
                return false;
            }
            true
        })
        .build();

    let mut dirs = Vec::new();
    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|ft| ft.is_dir()) {
            dirs.push(entry.into_path());
        }
    }
    dirs
}

// ============================================================================
// 事件处理
// ============================================================================

/// 把事件折叠进在线聚合表：分类 + 过滤忽略目录后，按 path 合并保留最高 severity。
///
/// 相比原先「先攒原始 Vec<Event>、flush 时才展开去重」，这里在事件到达时即完成
/// 分类/过滤/去重，事件风暴下内存只随唯一路径数增长。
fn ingest_event(pending: &mut HashMap<String, FsChangeKind>, root: &Path, event: &Event) {
    let kind = classify_event_kind(&event.kind);
    for path in &event.paths {
        if is_ignored_change(root, path) {
            continue;
        }
        merge_change(
            pending,
            FsChange {
                path: path.to_string_lossy().into_owned(),
                kind,
            },
        );
    }
}

/// 把已在线聚合好的一批变更按 path 排序后，作为单个 `WorkspaceFsEvent` 推送到前端。
fn flush_events(pending: &mut HashMap<String, FsChangeKind>, app: &AppHandle, root: &Path) {
    if pending.is_empty() {
        return;
    }
    let changes = drain_sorted(std::mem::take(pending));

    let payload = WorkspaceFsEvent {
        changes,
        root_path: root.to_string_lossy().into_owned(),
    };

    // 强类型 emit：事件名由 impl(Event) 的 `WorkspaceFsEvent::NAME` 统一保证，
    // 避免硬编码字符串与 TS 绑定漂移。
    if let Err(e) = payload.emit(app) {
        log::warn!("发送工作区文件事件失败: {e}");
    }
}

/// 把单条变更折叠进按 path 聚合表：仅保留 severity 最高的 kind。
fn merge_change(by_path: &mut HashMap<String, FsChangeKind>, change: FsChange) {
    by_path
        .entry(change.path)
        .and_modify(|kind| {
            if severity(change.kind) > severity(*kind) {
                *kind = change.kind;
            }
        })
        .or_insert(change.kind);
}

/// 把在线聚合表展开为按 path 升序排序的稳定列表。
///
/// 事件循环已改为在线聚合（见 `ingest_event`），不再先攒原始事件再 flush 去重：
/// 内存只随唯一路径数 u 增长，flush 仅对 u 个路径排序，O(u log u)。
fn drain_sorted(by_path: HashMap<String, FsChangeKind>) -> Vec<FsChange> {
    let mut changes: Vec<FsChange> = by_path
        .into_iter()
        .map(|(path, kind)| FsChange { path, kind })
        .collect();
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}

/// notify EventKind → 内部 FsChangeKind
///
/// macOS rename 会以 `Modify(Name(_))` 发出，必须单独识别为 `Renamed`，
/// 否则 rename 会和 modified 混在一起，前端无法刷新树形位置。
fn classify_event_kind(kind: &EventKind) -> FsChangeKind {
    match kind {
        EventKind::Create(_) => FsChangeKind::Created,
        EventKind::Remove(_) => FsChangeKind::Removed,
        EventKind::Modify(ModifyKind::Name(_)) => FsChangeKind::Renamed,
        EventKind::Modify(_) => FsChangeKind::Modified,
        EventKind::Access(_) | EventKind::Other | EventKind::Any => FsChangeKind::Modified,
    }
}

/// 去重时的优先级：Removed > Renamed > Created > Modified
///
/// 直觉：同一路径在一批次内既被改又被删，应当告诉前端\"它没了\"，
/// 而不是\"它被改了\"——后者会导致前端尝试读取已删文件。
fn severity(kind: FsChangeKind) -> u8 {
    match kind {
        FsChangeKind::Removed => 3,
        FsChangeKind::Renamed => 2,
        FsChangeKind::Created => 1,
        FsChangeKind::Modified => 0,
    }
}

// ============================================================================
// 路径忽略
// ============================================================================

/// 按目录名判断是否命中固定黑名单（Windows 大小写不敏感）。
fn is_ignored_dir_name(name: &str) -> bool {
    IGNORED_DIR_NAMES
        .iter()
        .any(|ignored| os_str_eq(OsStr::new(name), OsStr::new(ignored)))
}

/// `.git` 内部高频 / 无意义子目录：继续忽略以免 commit / gc / fetch 刷屏。
///
/// 注意：`.git` 顶层状态文件（HEAD / index / packed-refs）以及 `.git/refs`、
/// `.git/logs` **不在**此列，予以放行，让外部 git commit / checkout / pull
/// 写入的状态能触发前端 git 面板刷新。
const IGNORED_GIT_INTERNAL_DIRS: &[&str] = &["objects", "lfs", "tmp", "fsmonitor--daemon"];

/// 判断相对路径是否落在 `.git` 内部的高频忽略子目录里（如 `.git/objects/**`）。
///
/// 仅当相对路径第一段是 `.git` 且第二段命中 `IGNORED_GIT_INTERNAL_DIRS` 时为 true。
/// `.git/HEAD`、`.git/index`、`.git/refs/**`、`.git/logs/**` 等放行，
/// 以便外部 git 操作能驱动前端 git 面板刷新。
fn is_ignored_git_internal(relative: &Path) -> bool {
    let mut normals = relative.components().filter_map(|component| match component {
        Component::Normal(name) => Some(name),
        _ => None,
    });
    match normals.next() {
        Some(first) if os_str_eq(first, OsStr::new(".git")) => match normals.next() {
            Some(second) => IGNORED_GIT_INTERNAL_DIRS
                .iter()
                .any(|dir| os_str_eq(second, OsStr::new(dir))),
            // `.git` 顶层文件（HEAD / index / packed-refs）：放行
            None => false,
        },
        _ => false,
    }
}

/// 判断变更路径是否落在监听根下被忽略的目录内。
fn is_ignored_change(root: &Path, path: &Path) -> bool {
    let Some(relative) = relativize(root, path) else {
        // 无法判定归属（前缀形态不一致等）时放行，避免漏报真实改动。
        return false;
    };
    // `.git`：只忽略高频内部目录（objects 等），放行顶层状态文件 / refs / logs，
    // 这样外部 git commit / checkout / pull 能触发前端刷新。
    if is_ignored_git_internal(&relative) {
        return true;
    }
    relative.components().any(|component| match component {
        Component::Normal(name) => IGNORED_DIR_NAMES
            .iter()
            .any(|ignored| os_str_eq(name, OsStr::new(ignored))),
        _ => false,
    })
}

/// 按组件逐级剥掉监听根前缀，返回根 *之下* 的相对路径。
///
/// 仅比较相对组件可避免一个隐蔽陷阱：当用户把工作区直接开在名为
/// `node_modules`（或 `target` 等）的目录里时，不应把整棵树误判为被忽略。
/// 前缀形态不一致（罕见）时返回 `None`，调用方据此放行。
fn relativize(root: &Path, path: &Path) -> Option<PathBuf> {
    let mut root_components = root.components();
    let mut path_components = path.components();
    loop {
        match root_components.next() {
            None => return Some(path_components.as_path().to_path_buf()),
            Some(root_component) => {
                let path_component = path_components.next()?;
                if !os_str_eq(root_component.as_os_str(), path_component.as_os_str()) {
                    return None;
                }
            }
        }
    }
}

/// 路径组件相等性：Windows 上大小写不敏感，其它平台精确匹配。
/// 与 `commands::git` 中仓库根前缀比较保持一致的跨平台语义。
#[cfg(windows)]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    fn change(path: &str, kind: FsChangeKind) -> FsChange {
        FsChange {
            path: path.to_string(),
            kind,
        }
    }

    #[test]
    fn coalesces_changes_by_highest_severity_and_path_order() {
        let mut by_path = HashMap::new();
        for entry in [
            change("/ws/b.sh", FsChangeKind::Modified),
            change("/ws/a.sh", FsChangeKind::Created),
            change("/ws/b.sh", FsChangeKind::Removed),
            change("/ws/a.sh", FsChangeKind::Modified),
        ] {
            merge_change(&mut by_path, entry);
        }

        let observed: Vec<(String, FsChangeKind)> = drain_sorted(by_path)
            .into_iter()
            .map(|change| (change.path, change.kind))
            .collect();
        assert_eq!(
            observed,
            vec![
                ("/ws/a.sh".to_string(), FsChangeKind::Created),
                ("/ws/b.sh".to_string(), FsChangeKind::Removed),
            ]
        );
    }

    #[test]
    fn ignores_dependency_build_and_vcs_dirs() {
        let root = p("/ws");
        assert!(is_ignored_change(&root, &p("/ws/node_modules/lodash/index.js")));
        assert!(is_ignored_change(&root, &p("/ws/src-tauri/target/debug/app")));
        assert!(is_ignored_change(&root, &p("/ws/web/dist/bundle.js")));
        assert!(is_ignored_change(&root, &p("/ws/api/__pycache__/mod.pyc")));
        // .git 内部高频目录仍忽略（避免 commit / gc / fetch 刷屏）
        assert!(is_ignored_change(&root, &p("/ws/.git/objects/ab/cdef")));
        assert!(is_ignored_change(&root, &p("/ws/.git/lfs/objects/aa/bb")));
    }

    #[test]
    fn keeps_git_state_file_changes() {
        let root = p("/ws");
        // 外部 commit / checkout / pull 写入的 .git 状态文件必须放行，否则面板不刷新
        assert!(!is_ignored_change(&root, &p("/ws/.git/HEAD")));
        assert!(!is_ignored_change(&root, &p("/ws/.git/index")));
        assert!(!is_ignored_change(&root, &p("/ws/.git/packed-refs")));
        assert!(!is_ignored_change(&root, &p("/ws/.git/refs/heads/main")));
        assert!(!is_ignored_change(&root, &p("/ws/.git/logs/HEAD")));
    }

    #[test]
    fn keeps_real_source_changes() {
        let root = p("/ws");
        assert!(!is_ignored_change(&root, &p("/ws/src/main.rs")));
        assert!(!is_ignored_change(
            &root,
            &p("/ws/src-tauri/src/commands/mod.rs")
        ));
    }

    #[test]
    fn only_relative_components_are_inspected() {
        // 工作区根自身就在名为 node_modules 的目录里：根之下的源码不应被误伤
        let root = p("/home/user/node_modules/my-project");
        assert!(!is_ignored_change(
            &root,
            &p("/home/user/node_modules/my-project/src/main.rs")
        ));
        // 但根之下真正的 node_modules 仍被忽略
        assert!(is_ignored_change(
            &root,
            &p("/home/user/node_modules/my-project/node_modules/x.js")
        ));
    }

    #[test]
    fn unrelated_path_fails_open() {
        // 前缀不匹配时放行（返回 false），宁可多推一条也不漏报
        let root = p("/ws");
        assert!(!is_ignored_change(&root, &p("/elsewhere/node_modules/x.js")));
    }

    #[test]
    fn ignored_dir_name_matching() {
        assert!(is_ignored_dir_name("node_modules"));
        assert!(is_ignored_dir_name("target"));
        // .git 改为按子路径精细判定（见 is_ignored_git_internal），不再整目录忽略
        assert!(!is_ignored_dir_name(".git"));
        assert!(!is_ignored_dir_name("src"));
        assert!(!is_ignored_dir_name("targets"));
    }
}
