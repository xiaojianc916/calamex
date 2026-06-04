//! AED 路径安全层。
//!
//! 这里集中处理 AI 自动写盘相关的路径入口：UTF-8、NUL、`..`、protected path、
//! 工作区边界和 capability 目录校验。业务模块不得再各自手写路径判断。

use crate::ai::edit::errors;
use crate::ai::edit::security::protected_paths;
use camino::{Utf8Path, Utf8PathBuf};
use cap_std::ambient_authority;
use cap_std::fs::Dir;
#[cfg(windows)]
use normpath::PathExt;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// AED 写盘路径校验结果。
#[derive(Debug, Clone)]
pub struct ValidatedPath {
    path: PathBuf,
}

impl ValidatedPath {
    pub fn into_path_buf(self) -> PathBuf {
        self.path
    }
}

/// 校验单个 AED 可写路径。
pub fn validate_ai_writable_path(raw_path: &str) -> Result<PathBuf, String> {
    validate_ai_writable_path_with_root(raw_path, None).map(ValidatedPath::into_path_buf)
}

/// 校验单个 AED 可写路径，并在提供工作区根目录时强制目标留在根目录内。
pub fn validate_ai_writable_path_with_root(
    raw_path: &str,
    workspace_root: Option<&str>,
) -> Result<ValidatedPath, String> {
    let trimmed = validate_raw_path_text(raw_path, "AI 写入路径")?;
    let input_path = PathBuf::from(trimmed);
    validate_utf8_path(&input_path)?;
    validate_no_parent_component(&input_path)?;

    if protected_paths::is_builtin_protected_path(trimmed) {
        return Err(errors::path_protected(
            "命中内置 protected path 规则，需要用户显式二次确认。",
        ));
    }

    let resolved_path = match workspace_root.and_then(normalize_optional_root) {
        Some(root) => resolve_inside_workspace(&input_path, &root)?,
        None => normalize_path_lossless(&input_path)?,
    };

    if protected_paths::is_builtin_protected_path(&normalize_path_for_compare_path(&resolved_path))
    {
        return Err(errors::path_protected(
            "命中内置 protected path 规则，需要用户显式二次确认。",
        ));
    }

    if let Some(root) = workspace_root.and_then(normalize_optional_root) {
        let normalized_root = normalize_root_path(&root)?;
        let relative = to_sandbox_relative_path(&normalized_root, &resolved_path)?;
        assert_capability_scope(&normalized_root, &relative)?;
    }

    Ok(ValidatedPath {
        path: resolved_path,
    })
}

pub fn normalize_path_for_compare_path(path: &Path) -> String {
    normalize_path_text(&path.to_string_lossy())
}

fn validate_raw_path_text<'a>(raw_path: &'a str, label: &str) -> Result<&'a str, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(errors::path_invalid(format!("{label}不能为空。")));
    }
    if trimmed.contains('\0') {
        return Err(errors::path_invalid(format!("{label}包含 NUL 字符。")));
    }
    Ok(trimmed)
}

fn validate_utf8_path(path: &Path) -> Result<(), String> {
    Utf8Path::from_path(path)
        .map(|_| ())
        .ok_or_else(|| errors::path_invalid("路径不是有效 UTF-8。"))
}

fn validate_no_parent_component(path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(errors::path_escape(
            "路径包含 `..`，为避免越过工作区已拒绝。",
        ));
    }
    Ok(())
}

fn normalize_optional_root(raw_root: &str) -> Option<String> {
    let trimmed = raw_root.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn resolve_inside_workspace(path: &Path, workspace_root: &str) -> Result<PathBuf, String> {
    let root = normalize_root_path(workspace_root)?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let normalized_candidate = normalize_path_lossless(&candidate)?;

    if !path_starts_with(&normalized_candidate, &root) {
        return Err(errors::path_escape(format!(
            "目标路径不在当前工作区内：{}",
            normalized_candidate.display()
        )));
    }

    if normalized_candidate == root {
        return Err(errors::path_invalid("AI 写入路径不能指向工作区根目录。"));
    }

    Ok(normalized_candidate)
}

fn normalize_root_path(raw_root: &str) -> Result<PathBuf, String> {
    let trimmed = validate_raw_path_text(raw_root, "工作区根目录")?;
    let root = PathBuf::from(trimmed);
    validate_utf8_path(&root)?;
    validate_no_parent_component(&root)?;

    let normalized = normalize_path_lossless(&root)?;
    if !normalized.is_dir() {
        return Err(errors::path_invalid(format!(
            "工作区根目录不存在或不是目录：{}",
            normalized.display()
        )));
    }
    Ok(normalized)
}

#[cfg(windows)]
fn normalize_path_lossless(path: &Path) -> Result<PathBuf, String> {
    if path.is_relative() {
        return Ok(lexical_normalize(path));
    }
    path.normalize_virtually()
        .map(|value| value.into_path_buf())
        .map_err(|error| errors::path_invalid(format!("路径规范化失败：{error}")))
}

#[cfg(not(windows))]
fn normalize_path_lossless(path: &Path) -> Result<PathBuf, String> {
    Ok(lexical_normalize(path))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn to_sandbox_relative_path(root: &Path, candidate: &Path) -> Result<Utf8PathBuf, String> {
    let relative = candidate.strip_prefix(root).map_err(|_| {
        errors::path_escape(format!("目标路径不在工作区内：{}", candidate.display()))
    })?;
    let relative = Utf8Path::from_path(relative)
        .ok_or_else(|| errors::path_invalid("相对路径不是有效 UTF-8。"))?;
    if relative.as_str().is_empty() {
        return Err(errors::path_invalid("AI 写入路径不能为空。"));
    }
    Ok(relative.to_path_buf())
}

fn assert_capability_scope(root: &Path, relative: &Utf8Path) -> Result<(), String> {
    let root_dir = Dir::open_ambient_dir(root, ambient_authority())
        .map_err(|error| errors::path_escape(format!("打开工作区 capability 目录失败：{error}")))?;

    let parent = relative.parent().filter(|value| !value.as_str().is_empty());
    let Some(parent) = parent else {
        return Ok(());
    };

    match root_dir.open_dir(parent.as_std_path()) {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(errors::path_escape(format!(
            "工作区 capability 校验失败（{}）：{error}",
            parent
        ))),
    }
}

fn path_starts_with(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = normalize_path_for_compare_path(path);
        let root = normalize_path_for_compare_path(root);
        path == root || path.starts_with(&format!("{root}/"))
    }
    #[cfg(not(windows))]
    {
        path.starts_with(root)
    }
}

fn normalize_path_text(raw_path: &str) -> String {
    let mut value = raw_path.trim().replace('\\', "/");
    while value.ends_with('/') && value.len() > 1 {
        value.pop();
    }
    #[cfg(windows)]
    {
        value = value.to_lowercase();
    }
    value
}

/// 校验目标路径当前不是 symlink。对已存在文件做额外防护，避免 AI 写入跟随
/// 受控目录内指向外部的链接。
pub fn reject_existing_symlink(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(errors::path_escape(format!(
            "目标路径是符号链接，已拒绝自动写入：{}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(errors::path_invalid(format!(
            "读取路径元数据失败（{}）：{error}",
            path.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_path_for_compare_path, reject_existing_symlink, validate_ai_writable_path,
        validate_ai_writable_path_with_root,
    };
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn validate_rejects_empty_nul_parent_and_protected_paths() {
        assert!(validate_ai_writable_path("  ").is_err());
        assert!(validate_ai_writable_path("src\0main.ts").is_err());
        assert!(validate_ai_writable_path("../secret.txt").is_err());
        assert!(validate_ai_writable_path(".git/config").is_err());
        assert!(validate_ai_writable_path("src/脚本-🔧.sh").is_ok());
    }

    #[test]
    fn validate_with_root_allows_children_and_rejects_escape() {
        let root = temp_dir("aed-path-security-root");
        fs::create_dir_all(root.join("src")).expect("root should be created");

        let accepted =
            validate_ai_writable_path_with_root("src/main.ts", Some(&root.to_string_lossy()))
                .expect("child path should be accepted");
        assert!(
            accepted
                .into_path_buf()
                .ends_with(std::path::Path::new("src").join("main.ts"))
        );

        let outside = root
            .parent()
            .expect("temp dir should have parent")
            .join("outside.txt");
        assert!(
            validate_ai_writable_path_with_root(
                &outside.to_string_lossy(),
                Some(&root.to_string_lossy())
            )
            .is_err()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_compare_handles_windows_separators_and_unicode() {
        assert_eq!(
            normalize_path_for_compare_path(std::path::Path::new(r"src\脚本\🔧.sh/")),
            "src/脚本/🔧.sh"
        );
    }

    #[test]
    fn symlink_check_allows_missing_regular_paths() {
        let root = temp_dir("aed-path-security-symlink");
        fs::create_dir_all(&root).expect("root should be created");
        let missing = root.join("missing.txt");
        assert!(reject_existing_symlink(&missing).is_ok());

        let regular = root.join("regular.txt");
        fs::write(&regular, "ok").expect("regular file should be written");
        assert!(reject_existing_symlink(&regular).is_ok());

        let _ = fs::remove_dir_all(root);
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ))
    }
}
