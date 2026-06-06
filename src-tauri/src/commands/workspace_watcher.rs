//! 工作区文件系统监听
//!
//! - 用 `ignore::WalkBuilder` 对根目录做「剪枝遍历」，只对存活目录逐个加
//!   `RecursiveMode::NonRecursive` 监听，从源头跳过 node_modules / target / .git
//!   等重型目录——而不是像旧版那样递归监听整棵树、事后再丢弃事件。
//! - 200ms 去抖后通过强类型 specta 事件推送到前端
//! - 遍历 + 监听 + 事件循环全部在后台线程执行，打开大仓库时绝不阻塞命令返回 / 冻结 UI
//! - 同一时刻只有一个活跃监听；启动时若已有则「先建后换」，旧监听由原子标志位通知退出
//! - 跨平台：Linux (inotify) / macOS (FSEvents) / Windows (ReadDirectoryChangesW)

use arc_swap::ArcSwapOption;
use ignore::WalkBuilder;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, event::ModifyKind};
use notify_debouncer_full::{DebounceEventResult, Debouncer, FileIdMap, new_debouncer};
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsStr,
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{Receiver, RecvTimeoutError, channel},
    },
    thread,
    time::Duration,
};
use tauri::AppHandle;
use tauri_specta::Event as _;

const DEBOUNCE_DURATION: Duration = Duration::from_millis(200);

/// 后台事件循环等待事件的最长阻塞时间；超时即回头检查停止标志，
/// 保证 stop / 热替换后线程能在亚秒级退出。
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 始终忽略的目录名（按目录名匹配，相对监听根的任意层级）。
///
/// 作为 `.gitignore` 之外的兜底黑名单：即便仓库没有写 .gitignore（或根本不是
/// git 仓库），这些目录在依赖安装 / 构建 / git 操作时也会喷出成千上万条无意义
/// 事件、灌满去抖窗口、拖垮前端刷新。语义对齐编辑器通行的 watcher 排除清单。
const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
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

type WorkspaceDebouncer = Debouncer<RecommendedWatcher, FileIdMap>;

/// 单个活跃监听的句柄。
///
/// debouncer 本体由后台线程持有（见 `run_watch_loop`），这里只保留通知其退出的
/// 原子标志位；置 true 后线程会在 `STOP_POLL_INTERVAL` 内跳出循环并 Drop debouncer。
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
/// 真正的目录遍历与监听在后台线程完成，本命令仅做根目录校验与 debouncer 构造后
/// 立即返回，因此打开超大仓库也不会阻塞前端。监听结果通过 `WorkspaceFsEvent` 推送。
/// 若已有监听，会先换入新句柄再通知旧线程退出，旧 debouncer 在其线程结束时 Drop。
///
/// # 参数
/// - `root_path`: 工作区根目录的绝对或相对路径，会被 canonicalize
///
/// # 错误
/// 路径不存在 / 不是目录、或 debouncer 构造失败时返回 `Err(String)`。
/// 注意：后台遍历 / 单目录 watch 失败只记日志，不再同步抛出（后台化的取舍）。
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

    // 2. 构造 debouncer
    //    事件仅通过 channel 投递给后台线程处理；后台线程持有 debouncer，因而可在
    //    回调之外安全地动态 watch/unwatch（回调本身不触碰 debouncer，杜绝重入死锁）。
    //    构造失败时不要触碰 state，旧监听（若有）保持不动。
    let (tx, rx) = channel::<DebounceEventResult>();
    let debouncer = new_debouncer(DEBOUNCE_DURATION, None, move |result: DebounceEventResult| {
        // 后台线程退出后 rx 被 Drop，send 失败可安全忽略。
        let _ = tx.send(result);
    })
    .map_err(|e| format!("创建文件监听器失败：{e}"))?;

    // 3. 后台启动：剪枝遍历 + 逐目录非递归监听 + 事件循环全部丢到独立线程，
    //    打开大仓库时绝不阻塞命令返回 / 冻结 UI。
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let worker_root = root.clone();
    thread::Builder::new()
        .name("workspace-watcher".into())
        .spawn(move || run_watch_loop(debouncer, rx, app, worker_root, worker_stop))
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
/// 通知后台线程退出；线程在 `STOP_POLL_INTERVAL` 内跳出循环并 Drop debouncer。
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

/// 后台线程主体：先把存活目录全部挂上监听，随后循环消费去抖事件直到收到停止信号。
fn run_watch_loop(
    mut debouncer: WorkspaceDebouncer,
    rx: Receiver<DebounceEventResult>,
    app: AppHandle,
    root: PathBuf,
    stop: Arc<AtomicBool>,
) {
    // 初始：剪枝遍历，逐目录非递归监听。
    let mut watched = 0usize;
    for dir in collect_watch_dirs(&root) {
        match debouncer.watch(&dir, RecursiveMode::NonRecursive) {
            Ok(()) => watched += 1,
            Err(e) => log::warn!("监听目录失败 {}: {e}", dir.display()),
        }
    }
    log::info!(
        "工作区文件监听已就绪：{watched} 个目录（根 {}）",
        root.display()
    );

    // 事件循环：recv_timeout 让线程既能及时处理事件，又能周期性检查停止标志。
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match rx.recv_timeout(STOP_POLL_INTERVAL) {
            Ok(result) => handle_debounced_events(result, &app, &root, &mut debouncer),
            Err(RecvTimeoutError::Timeout) => continue,
            // 仅当 debouncer（持有 Sender）被 Drop 时才会发生；正常路径走 stop 标志。
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // 退出循环后 debouncer 在此 Drop，底层 watcher 关闭、内部线程回收。
    log::info!("工作区文件监听线程已退出: {}", root.display());
}

// ============================================================================
// 目录剪枝遍历
// ============================================================================

/// 在 `start` 子树内做「剪枝遍历」，返回所有需要监听的目录（含 `start` 本身）。
///
/// 剪枝规则（与编辑器通行做法对齐）：
/// - 尊重 `.gitignore` / `.ignore` / 全局 gitignore / `.git/info/exclude`
///   （由 ignore crate 处理；`parents(true)` 让子树遍历也能读到祖先的忽略规则）；
/// - 叠加固定黑名单 `IGNORED_DIR_NAMES` 作为兜底：即便仓库没写 .gitignore，
///   node_modules / target / .git 等也绝不进入；
/// - 隐藏目录不一刀切跳过（`hidden(false)`），交给上面两条规则决定，
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
            entry
                .file_name()
                .to_str()
                .map(|name| !is_ignored_dir_name(name))
                .unwrap_or(true)
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

fn handle_debounced_events(
    result: DebounceEventResult,
    app: &AppHandle,
    root: &Path,
    debouncer: &mut WorkspaceDebouncer,
) {
    let events = match result {
        Ok(events) => events,
        Err(errors) => {
            for e in errors {
                log::warn!("文件监听产生错误事件: {e}");
            }
            return;
        }
    };

    if events.is_empty() {
        return;
    }

    // 动态维护监听集合（非递归监听必须自己跟进目录增删）：
    // - 新建目录：剪枝子遍历后补挂监听，覆盖「mkdir -p a/b/c」「git checkout 拉出整棵新目录」等情形；
    // - 删除目录：best-effort 解除监听（删的是文件时 unwatch 失败，忽略即可）。
    for ev in &events {
        match &ev.event.kind {
            EventKind::Create(_) => {
                for path in &ev.event.paths {
                    if path.is_dir() && !is_ignored_change(root, path) {
                        for dir in collect_watch_dirs(path) {
                            let _ = debouncer.watch(&dir, RecursiveMode::NonRecursive);
                        }
                    }
                }
            }
            EventKind::Remove(_) => {
                for path in &ev.event.paths {
                    let _ = debouncer.unwatch(path);
                }
            }
            _ => {}
        }
    }

    // 展开为 (path, kind) 列表，并丢弃落在被忽略目录内的变更（事件级兜底过滤：
    // 监听本身已不覆盖忽略目录，这里再挡一道被 .gitignore 命中的零散文件）。
    // 每个 DebouncedEvent 可能携带多个路径（如 rename 携带 from/to）。
    let mut changes: Vec<FsChange> = events
        .iter()
        .flat_map(|ev| {
            let kind = classify_event_kind(&ev.event.kind);
            ev.event.paths.iter().filter_map(move |path| {
                if is_ignored_change(root, path) {
                    return None;
                }
                Some(FsChange {
                    path: path.to_string_lossy().into_owned(),
                    kind,
                })
            })
        })
        .collect();

    // 去重：同路径保留 severity 最高的 kind
    changes.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then_with(|| severity(b.kind).cmp(&severity(a.kind)))
    });
    changes.dedup_by(|a, b| a.path == b.path);

    if changes.is_empty() {
        return;
    }

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

/// 判断变更路径是否落在监听根下被忽略的目录内。
fn is_ignored_change(root: &Path, path: &Path) -> bool {
    let Some(relative) = relativize(root, path) else {
        // 无法判定归属（前缀形态不一致等）时放行，避免漏报真实改动。
        return false;
    };
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

    #[test]
    fn ignores_dependency_build_and_vcs_dirs() {
        let root = p("/ws");
        assert!(is_ignored_change(&root, &p("/ws/node_modules/lodash/index.js")));
        assert!(is_ignored_change(&root, &p("/ws/.git/HEAD")));
        assert!(is_ignored_change(&root, &p("/ws/src-tauri/target/debug/app")));
        assert!(is_ignored_change(&root, &p("/ws/web/dist/bundle.js")));
        assert!(is_ignored_change(&root, &p("/ws/api/__pycache__/mod.pyc")));
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
        assert!(is_ignored_dir_name(".git"));
        assert!(!is_ignored_dir_name("src"));
        assert!(!is_ignored_dir_name("targets"));
    }
}
