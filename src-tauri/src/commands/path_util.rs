//! 跨平台路径前缀剥离与组件相等性比较。
//!
//! commands::search::scan 与 commands::workspace_watcher 历史上各自维护了一份逐字
//! 相同的 relativize / os_str_eq（含 Windows 大小写不敏感的 cfg 分支）。二者语义完全
//! 一致，且与 commands::git 中仓库根前缀比较保持一致的跨平台约定，故抽到此共享模块
//! 统一维护，避免两份实现日后漂移。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// 按组件逐级剥掉 root 前缀，返回 root 之下的相对路径。
///
/// 仅比较相对组件可避免一个隐蔽陷阱：当工作区根自身就在名为 node_modules（或
/// target 等）的目录里时，不应把整棵树误判为被忽略。前缀形态不一致（罕见）时返回
/// None，调用方据此放行。
pub(crate) fn relativize(root: &Path, path: &Path) -> Option<PathBuf> {
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
/// 与 commands::git 中仓库根前缀比较保持一致的跨平台语义。
#[cfg(windows)]
pub(crate) fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(not(windows))]
pub(crate) fn os_str_eq(left: &OsStr, right: &OsStr) -> bool {
    left == right
}
