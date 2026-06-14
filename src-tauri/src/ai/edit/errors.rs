//! AED（AI Edit Diff）模块统一错误码与错误文案构造器。
//!
//! - 所有错误码统一使用 `AI_EDIT_*` 前缀，常量名与字面量保持完全一致，
//!   便于前端 / 上层逻辑通过 `code` 字段识别。
//! - 所有错误文案均通过 [`crate::ai::errors::error`] 包装，保证整套
//!   AED 错误共享同一种错误结构。
//!
//! ## 新增错误码的步骤
//!
//! 1. 在「错误码常量」分区追加 `pub const AI_EDIT_<NAME>: &str = "AI_EDIT_<NAME>"`，
//!    常量名与字符串值必须保持一致。
//! 2. 在对应分组的「助手函数」分区追加同名 snake_case 函数。
//! 3. 通过该助手函数构造错误，**禁止**在业务模块里直接调用
//!    `crate::ai::errors::error(...)` 拼接 AED 错误码，避免文案和码值漂移。

use crate::ai::errors::error;

// ============================================================================
// 错误码常量
// ============================================================================

pub const AI_EDIT_INVALID_AUTH_LEVEL: &str = "AI_EDIT_INVALID_AUTH_LEVEL";
pub const AI_EDIT_AUTH_BLOCKED: &str = "AI_EDIT_AUTH_BLOCKED";
pub const AI_EDIT_STORAGE_PATH_UNAVAILABLE: &str = "AI_EDIT_STORAGE_PATH_UNAVAILABLE";
pub const AI_EDIT_STORAGE_LOCKED: &str = "AI_EDIT_STORAGE_LOCKED";
pub const AI_EDIT_PATH_INVALID: &str = "AI_EDIT_PATH_INVALID";
pub const AI_EDIT_PATH_PROTECTED: &str = "AI_EDIT_PATH_PROTECTED";
pub const AI_EDIT_PATH_ESCAPE: &str = "AI_EDIT_PATH_ESCAPE";
pub const AI_EDIT_TRANSACTION_FAILED: &str = "AI_EDIT_TRANSACTION_FAILED";
pub const AI_EDIT_JOURNAL_FAILED: &str = "AI_EDIT_JOURNAL_FAILED";
pub const AI_EDIT_SNAPSHOT_STORE_FAILED: &str = "AI_EDIT_SNAPSHOT_STORE_FAILED";
pub const AI_EDIT_SNAPSHOT_NOT_FOUND: &str = "AI_EDIT_SNAPSHOT_NOT_FOUND";
pub const AI_EDIT_OPERATION_NOT_FOUND: &str = "AI_EDIT_OPERATION_NOT_FOUND";
pub const AI_EDIT_TASK_NOT_FOUND: &str = "AI_EDIT_TASK_NOT_FOUND";
pub const AI_EDIT_RESTORE_CONFLICT: &str = "AI_EDIT_RESTORE_CONFLICT";
pub const AI_EDIT_RESTORE_FAILED: &str = "AI_EDIT_RESTORE_FAILED";

// ============================================================================
// 助手函数：授权 / 状态
// ============================================================================

/// 前端传入的 AED 授权等级无法解析（例如非预设枚举值）。
pub fn invalid_auth_level(level: &str) -> String {
    error(
        AI_EDIT_INVALID_AUTH_LEVEL,
        format!("不支持的 AED 授权等级：{level}"),
    )
}

/// 当前会话授权不足或被显式拒绝，AI 自动写盘已被阻止。
pub fn auth_blocked(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_AUTH_BLOCKED,
        format!("AED 自动写盘已被阻止：{}", detail.as_ref()),
    )
}

// ============================================================================
// 助手函数：存储 / 日志
// ============================================================================

/// AED 存储根目录无法解析（如 Tauri `app_data_dir` 返回错误、目录无写权限等）。
pub fn storage_path_unavailable(detail: &str) -> String {
    error(
        AI_EDIT_STORAGE_PATH_UNAVAILABLE,
        format!("无法解析 AED 存储目录：{detail}"),
    )
}

/// AED 存储目录已被同项目的另一个进程占用。
pub fn storage_locked(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_STORAGE_LOCKED,
        format!("AED 存储已被占用：{}", detail.as_ref()),
    )
}

/// AED 收到的路径为空、非 UTF-8、包含 NUL、`..` 等非法路径形态。
pub fn path_invalid(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_PATH_INVALID,
        format!("AED 路径非法：{}", detail.as_ref()),
    )
}

/// AED 目标命中内置受保护路径规则。
pub fn path_protected(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_PATH_PROTECTED,
        format!("AED 受保护路径已拒绝：{}", detail.as_ref()),
    )
}

/// AED 目标路径试图越过当前工作区或能力目录。
pub fn path_escape(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_PATH_ESCAPE,
        format!("AED 路径越界已拒绝：{}", detail.as_ref()),
    )
}

/// AED 文件事务准备、提交或恢复失败。
pub fn transaction_failed(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_TRANSACTION_FAILED,
        format!("AED 文件事务失败：{}", detail.as_ref()),
    )
}

/// 操作日志（NDJSON）读写失败。配合 `operations` 模块使用。
pub fn journal_failed(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_JOURNAL_FAILED,
        format!("写入 AED 编辑日志失败：{}", detail.as_ref()),
    )
}

// ============================================================================
// 助手函数：快照
// ============================================================================

/// 写入快照失败（序列化、目录创建、文件落盘等任意 I/O 错误）。
pub fn snapshot_store_failed(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_SNAPSHOT_STORE_FAILED,
        format!("写入 AED 快照失败：{}", detail.as_ref()),
    )
}

/// 按 `snapshot_id` 查找快照时未命中。
pub fn snapshot_not_found(snapshot_id: &str) -> String {
    error(
        AI_EDIT_SNAPSHOT_NOT_FOUND,
        format!("未找到 AED 快照：{snapshot_id}"),
    )
}

// ============================================================================
// 助手函数：操作 / 恢复
// ============================================================================

/// 按 `operation_id` 查找编辑操作时未命中。
pub fn operation_not_found(operation_id: &str) -> String {
    error(
        AI_EDIT_OPERATION_NOT_FOUND,
        format!("未找到 AED 编辑操作：{operation_id}"),
    )
}

/// 按 `task_id` 查找编辑任务时未命中。
pub fn task_not_found(task_id: &str) -> String {
    error(
        AI_EDIT_TASK_NOT_FOUND,
        format!("未找到 AED 编辑任务：{task_id}"),
    )
}

/// 快照恢复检测到冲突（如目标文件被外部改动、hash 不匹配、目录已存在等）。
pub fn restore_conflict(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_RESTORE_CONFLICT,
        format!("AED 快照恢复冲突：{}", detail.as_ref()),
    )
}

/// 快照恢复时发生不可恢复的错误（写盘失败、临时文件损坏等）。
pub fn restore_failed(detail: impl AsRef<str>) -> String {
    error(
        AI_EDIT_RESTORE_FAILED,
        format!("AED 快照恢复失败：{}", detail.as_ref()),
    )
}
