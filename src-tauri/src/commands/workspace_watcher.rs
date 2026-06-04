//! 工作区文件系统监听
//!
//! - 通过 notify-debouncer-full 监听根目录下的递归文件变化
//! - 200ms 去抖后通过强类型 specta 事件推送到前端
//! - 同一时刻只有一个活跃监听；启动时若已有则「先建后换」原子替换
//! - 跨平台：Linux (inotify) / macOS (FSEvents) / Windows (ReadDirectoryChangesW)

use arc_swap::ArcSwapOption;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, event::ModifyKind};
use notify_debouncer_full::{DebounceEventResult, Debouncer, FileIdMap, new_debouncer};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tauri::AppHandle;
use tauri_specta::Event as _;

const DEBOUNCE_DURATION: Duration = Duration::from_millis(200);

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

struct WatcherState {
    /// 持有 debouncer 让回调线程存活；Drop 时自动关闭底层 watcher
    #[allow(dead_code)]
    debouncer: WorkspaceDebouncer,
    /// 监听的根目录（保留用于诊断）
    #[allow(dead_code)]
    root_path: PathBuf,
}

/// 全局工作区监听器，保证同一时刻只有一个活跃 watcher
///
/// 使用 `ArcSwapOption` 支持热替换：先构造新 watcher，成功后再原子 swap，
/// 旧 watcher 在 Drop 中关闭，避免 stop → start 中间的真空期。
///
/// 通过 `app.manage(WorkspaceWatcher::default())` 注册到 Tauri State。
#[derive(Default)]
pub struct WorkspaceWatcher(ArcSwapOption<WatcherState>);

// ============================================================================
// Tauri 命令
// ============================================================================

/// 启动（或重启）工作区文件监听
///
/// 监听结果通过 `WorkspaceFsEvent` 事件推送到前端。
/// 若已有监听，会先构造新 watcher，成功后原子替换旧的，旧 watcher 在 Drop 中关闭。
///
/// # 参数
/// - `root_path`: 工作区根目录的绝对或相对路径，会被 canonicalize
///
/// # 错误
/// 路径不存在、不是目录、或底层 watcher 启动失败时返回 `Err(String)`
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

    // 2. 构造回调闭包所需的 owned 数据
    let cb_app = app.clone();
    let cb_root = root.to_string_lossy().into_owned();

    // 3. 构造 debouncer
    //    注意：失败时不要触碰 state，旧 watcher（若有）保持不动
    let mut debouncer = new_debouncer(
        DEBOUNCE_DURATION,
        None,
        move |result: DebounceEventResult| {
            handle_debounced_events(result, &cb_app, &cb_root);
        },
    )
    .map_err(|e| format!("创建文件监听器失败：{e}"))?;

    // 4. 订阅根目录（递归）
    //    没有这一步整个 watcher 就是空的、不会触发任何回调
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("监听工作区目录失败：{e}"))?;

    // 5. 原子替换；旧 watcher（若有）在 Arc Drop 时关闭
    let new_state = Arc::new(WatcherState {
        debouncer,
        root_path: root.clone(),
    });
    state.0.store(Some(new_state));

    log::info!("工作区文件监听已启动: {}", root.display());
    Ok(())
}

/// 停止工作区文件监听
///
/// 调用后 watcher 立即被 Drop，回调线程退出。
/// 重复调用、未启动时调用都是安全的（幂等）。
#[tauri::command]
#[specta::specta]
pub fn stop_workspace_watching(state: tauri::State<'_, WorkspaceWatcher>) -> Result<(), String> {
    state.0.store(None);
    log::info!("工作区文件监听已停止");
    Ok(())
}

// ============================================================================
// 事件处理
// ============================================================================

fn handle_debounced_events(result: DebounceEventResult, app: &AppHandle, root_path: &str) {
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

    // 展开为 (path, kind) 列表
    // 每个 DebouncedEvent 可能携带多个路径（如 rename 携带 from/to）
    // 每条事件保留自己的 kind，不像旧版那样被循环覆盖
    let mut changes: Vec<FsChange> = events
        .iter()
        .flat_map(|ev| {
            let kind = classify_event_kind(&ev.event.kind);
            ev.event.paths.iter().map(move |path| FsChange {
                path: path.to_string_lossy().into_owned(),
                kind,
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
        root_path: root_path.to_string(),
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
/// 直觉：同一路径在一批次内既被改又被删，应当告诉前端"它没了"，
/// 而不是"它被改了"——后者会导致前端尝试读取已删文件。
fn severity(kind: FsChangeKind) -> u8 {
    match kind {
        FsChangeKind::Removed => 3,
        FsChangeKind::Renamed => 2,
        FsChangeKind::Created => 1,
        FsChangeKind::Modified => 0,
    }
}
