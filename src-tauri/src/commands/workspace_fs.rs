use super::{
    DocumentEncoding, ImageAssetPayload, SaveScriptRequest, ScriptFilePayload,
    WorkspaceDirectoryPayload, WorkspaceEntry, WorkspacePathCreatePayload,
    WorkspacePathCreateRequest, WorkspacePathDeletePayload, WorkspacePathDeleteRequest,
    WorkspacePathKind, WorkspacePathRenamePayload, WorkspacePathRenameRequest, line_count,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use encoding_rs::{GB18030, UTF_8, UTF_16BE, UTF_16LE};
use std::{
    borrow::Cow,
    env, fs,
    path::{Path, PathBuf},
};

/// 脚本文件读取上限：超过则拒绝在编辑器中打开，避免一次性读入超大文件耗尽内存。
const MAX_SCRIPT_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// 图片资源读取上限：base64 编码约放大 1.37 倍并叠加 data URL 字符串，故上限略宽于脚本。
const MAX_IMAGE_ASSET_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub fn load_script(path: String) -> Result<ScriptFilePayload, String> {
    let file_path = PathBuf::from(&path);
    ensure_within_size_limit(&file_path, MAX_SCRIPT_FILE_BYTES, "脚本")?;
    let bytes = fs::read(&file_path).map_err(|error| format!("读取脚本失败：{error}"))?;
    let (content, encoding) = decode_script_bytes(&bytes)?;
    build_script_payload(file_path, content, encoding)
}

#[tauri::command]
#[specta::specta]
pub fn load_image_asset(path: String) -> Result<ImageAssetPayload, String> {
    let file_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("读取图片资源失败：{error}"))?;

    if !file_path.is_file() {
        return Err("目标图片不存在或不是有效文件。".into());
    }

    ensure_within_size_limit(&file_path, MAX_IMAGE_ASSET_BYTES, "图片资源")?;
    let bytes = fs::read(&file_path).map_err(|error| format!("读取图片资源失败：{error}"))?;
    build_image_asset_payload(file_path, bytes)
}

#[tauri::command]
#[specta::specta]
pub fn save_script(payload: SaveScriptRequest) -> Result<ScriptFilePayload, String> {
    let file_path = PathBuf::from(&payload.path);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }

    let bytes = encode_script_content(&payload.content, &payload.encoding)?;
    atomic_write(&file_path, &bytes)?;
    build_script_payload(file_path, payload.content, payload.encoding)
}

#[tauri::command]
#[specta::specta]
pub fn list_workspace_entries(
    path: Option<String>,
    root_path: Option<String>,
) -> Result<WorkspaceDirectoryPayload, String> {
    let workspace_root = resolve_workspace_root(root_path)?;
    let target_path = path
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.clone())
        .canonicalize()
        .map_err(|error| format!("读取资源目录失败：{error}"))?;

    if !target_path.starts_with(&workspace_root) {
        return Err("仅允许浏览当前资源根目录。".into());
    }

    if !target_path.is_dir() {
        return Err("目标路径不是有效目录。".into());
    }

    Ok(WorkspaceDirectoryPayload {
        root_path: workspace_root.to_string_lossy().to_string(),
        root_name: workspace_name(&workspace_root),
        entries: read_workspace_entries(&target_path)?,
    })
}

#[tauri::command]
#[specta::specta]
pub fn create_workspace_path(
    payload: WorkspacePathCreateRequest,
) -> Result<WorkspacePathCreatePayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.root_path))?;
    let parent_path = resolve_workspace_child_path(&workspace_root, &payload.parent_path)?;
    if !parent_path.is_dir() {
        return Err("目标父目录不是有效目录。".into());
    }

    let name = validate_workspace_entry_name(&payload.name)?;
    let target_path = parent_path.join(&name);
    if target_path.exists() {
        return Err("同名文件或文件夹已存在。".into());
    }

    match payload.kind {
        WorkspacePathKind::File => {
            fs::File::create(&target_path).map_err(|error| format!("创建文件失败：{error}"))?;
        }
        WorkspacePathKind::Directory => {
            fs::create_dir(&target_path).map_err(|error| format!("创建文件夹失败：{error}"))?;
        }
    }

    Ok(WorkspacePathCreatePayload {
        path: target_path.to_string_lossy().to_string(),
        name,
        kind: payload.kind,
    })
}

#[tauri::command]
#[specta::specta]
pub fn rename_workspace_path(
    payload: WorkspacePathRenameRequest,
) -> Result<WorkspacePathRenamePayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.root_path))?;
    let source_path = resolve_workspace_child_path(&workspace_root, &payload.path)?;
    if !source_path.exists() {
        return Err("目标文件或文件夹不存在。".into());
    }
    if source_path == workspace_root {
        return Err("不能重命名工作区根目录。".into());
    }

    let name = validate_workspace_entry_name(&payload.new_name)?;
    let parent = source_path
        .parent()
        .ok_or_else(|| "无法解析目标父目录。".to_string())?;
    let target_path = parent.join(&name);
    if target_path.exists() {
        return Err("同名文件或文件夹已存在。".into());
    }

    fs::rename(&source_path, &target_path).map_err(|error| format!("重命名失败：{error}"))?;

    Ok(WorkspacePathRenamePayload {
        old_path: source_path.to_string_lossy().to_string(),
        new_path: target_path.to_string_lossy().to_string(),
        name,
    })
}

#[tauri::command]
#[specta::specta]
pub fn delete_workspace_path(
    payload: WorkspacePathDeleteRequest,
) -> Result<WorkspacePathDeletePayload, String> {
    let workspace_root = resolve_workspace_root(Some(payload.root_path))?;
    let target_path = resolve_workspace_child_path(&workspace_root, &payload.path)?;
    if target_path == workspace_root {
        return Err("不能删除工作区根目录。".into());
    }
    if !target_path.exists() {
        return Err("目标文件或文件夹不存在。".into());
    }

    trash::delete(&target_path).map_err(|error| format!("移动到回收站失败：{error}"))?;

    Ok(WorkspacePathDeletePayload {
        path: target_path.to_string_lossy().to_string(),
    })
}

pub(crate) fn resolve_workspace_root(selected_root: Option<String>) -> Result<PathBuf, String> {
    if let Some(root) = selected_root {
        let root_path = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| format!("读取资源根目录失败：{error}"))?;

        if !root_path.is_dir() {
            return Err("资源根路径不是有效目录。".into());
        }

        return Ok(root_path);
    }

    if let Ok(current_dir) = env::current_dir() {
        if current_dir.join("package.json").exists()
            || current_dir.join("src").exists()
            || current_dir.join("resources").exists()
        {
            return current_dir
                .canonicalize()
                .map_err(|error| format!("读取工作区目录失败：{error}"));
        }

        if current_dir
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("src-tauri"))
            && let Some(parent) = current_dir.parent()
        {
            return parent
                .to_path_buf()
                .canonicalize()
                .map_err(|error| format!("读取工作区目录失败：{error}"));
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fallback_root = manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir);
    fallback_root
        .canonicalize()
        .map_err(|error| format!("读取工作区目录失败：{error}"))
}

pub(crate) fn workspace_name(root_path: &Path) -> String {
    root_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("workspace")
        .to_string()
}

fn resolve_workspace_child_path(workspace_root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let target_path = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|error| format!("解析资源路径失败：{error}"))?;

    if !target_path.starts_with(workspace_root) {
        return Err("仅允许操作当前资源根目录内的路径。".into());
    }

    Ok(target_path)
}

fn validate_workspace_entry_name(raw_name: &str) -> Result<String, String> {
    let name = raw_name.trim();
    if name.is_empty() {
        return Err("名称不能为空。".into());
    }

    if name == "." || name == ".." {
        return Err("名称不能为 . 或 ..。".into());
    }

    let candidate = Path::new(name);
    if candidate.file_name().and_then(|value| value.to_str()) != Some(name) {
        return Err("名称不能包含路径分隔符。".into());
    }

    const INVALID_CHARS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    if name
        .chars()
        .any(|character| INVALID_CHARS.contains(&character) || character.is_control())
    {
        return Err("名称包含非法字符。".into());
    }

    Ok(name.to_string())
}

/// 校验文件大小未超过上限，避免一次性读入超大文件耗尽内存。
fn ensure_within_size_limit(path: &Path, max_bytes: u64, label: &str) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取{label}失败：{error}"))?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "{label}过大（{:.1} MB），超过 {} MB 上限，已取消读取。",
            metadata.len() as f64 / (1024.0 * 1024.0),
            max_bytes / (1024 * 1024)
        ));
    }
    Ok(())
}

/// 原子写入：先写入同目录下的临时文件，再 rename 覆盖目标，
/// 避免写入中途崩溃 / 断电导致原文件被截断、内容丢失。
fn atomic_write(file_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法解析目标文件名。".to_string())?;
    let temp_path = match file_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(format!(".{file_name}.tmp")),
        _ => PathBuf::from(format!(".{file_name}.tmp")),
    };

    fs::write(&temp_path, bytes).map_err(|error| format!("保存脚本失败：{error}"))?;
    if let Err(error) = fs::rename(&temp_path, file_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("保存脚本失败：{error}"));
    }
    Ok(())
}

pub(crate) fn decode_script_bytes(bytes: &[u8]) -> Result<(String, DocumentEncoding), String> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let content = String::from_utf8(bytes[3..].to_vec()).map_err(|error| error.to_string())?;
        return Ok((content, DocumentEncoding::Utf8Bom));
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_with_encoding(&bytes[2..], UTF_16LE, DocumentEncoding::Utf16le);
    }

    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_with_encoding(&bytes[2..], UTF_16BE, DocumentEncoding::Utf16be);
    }

    if bytes.contains(&0) {
        return Err("当前文件疑似二进制内容，暂不支持在编辑器中打开。".into());
    }

    let (utf8, _, utf8_errors) = UTF_8.decode(bytes);
    if !utf8_errors {
        return Ok((utf8.into_owned(), DocumentEncoding::Utf8));
    }

    let (gb18030, _, gb_errors) = GB18030.decode(bytes);
    if !gb_errors {
        return Ok((gb18030.into_owned(), DocumentEncoding::Gb18030));
    }

    Err("无法识别文件编码，请确认脚本是否为常见 UTF-8 / GB 编码。".into())
}

pub(crate) fn encode_script_content(
    content: &str,
    encoding: &DocumentEncoding,
) -> Result<Vec<u8>, String> {
    match encoding {
        DocumentEncoding::Utf8 => Ok(content.as_bytes().to_vec()),
        DocumentEncoding::Utf8Bom => {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(content.as_bytes());
            Ok(bytes)
        }
        DocumentEncoding::Utf16le => {
            encode_with_encoding(content, UTF_16LE, DocumentEncoding::Utf16le, true)
        }
        DocumentEncoding::Utf16be => {
            encode_with_encoding(content, UTF_16BE, DocumentEncoding::Utf16be, true)
        }
        DocumentEncoding::Gbk => encode_with_encoding_name(content, "gbk"),
        DocumentEncoding::Gb18030 => encode_with_encoding_name(content, "gb18030"),
    }
}

fn build_script_payload(
    path: PathBuf,
    content: String,
    encoding: DocumentEncoding,
) -> Result<ScriptFilePayload, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("untitled.sh")
        .to_string();

    Ok(ScriptFilePayload {
        path: path.to_string_lossy().to_string(),
        name,
        line_count: count_to_u32(line_count(&content), "脚本行数")?,
        char_count: count_to_u32(content.chars().count(), "脚本字符数")?,
        content,
        encoding,
    })
}

fn build_image_asset_payload(path: PathBuf, bytes: Vec<u8>) -> Result<ImageAssetPayload, String> {
    let mime_type = resolve_image_mime_type(&path)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();
    let byte_size = count_to_u32(bytes.len(), "图片字节数")?;
    let data_url = format!("data:{mime_type};base64,{}", STANDARD.encode(&bytes));

    Ok(ImageAssetPayload {
        path: path.to_string_lossy().to_string(),
        name,
        mime_type: mime_type.to_string(),
        data_url,
        byte_size,
    })
}

fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

fn resolve_image_mime_type(path: &Path) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "无法识别图片格式。".to_string())?;

    match extension.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "bmp" => Ok("image/bmp"),
        "svg" => Ok("image/svg+xml"),
        "ico" => Ok("image/x-icon"),
        _ => Err(format!("暂不支持预览该图片格式：{extension}")),
    }
}

fn read_workspace_entries(directory: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let read_dir = fs::read_dir(directory).map_err(|error| format!("读取资源目录失败：{error}"))?;
    let mut entries = Vec::new();
    let (minimum_entry_count, _) = read_dir.size_hint();
    entries.reserve(minimum_entry_count);

    for item in read_dir {
        let Ok(entry) = item else {
            continue;
        };

        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_directory = file_type.is_dir();

        entries.push(WorkspaceEntry {
            path: path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            kind: if is_directory {
                WorkspacePathKind::Directory
            } else {
                WorkspacePathKind::File
            },
            has_children: is_directory && directory_has_entries(&path),
        });
    }

    entries.sort_by_cached_key(|entry| {
        (
            entry.kind.as_str() != "directory",
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    Ok(entries)
}

fn directory_has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut iterator| iterator.any(|item| item.is_ok()))
        .unwrap_or(false)
}

fn decode_with_encoding(
    bytes: &[u8],
    encoding: &'static encoding_rs::Encoding,
    document_encoding: DocumentEncoding,
) -> Result<(String, DocumentEncoding), String> {
    let (content, _, had_errors) = encoding.decode(bytes);
    if had_errors {
        return Err(format!("使用 {document_encoding} 解码脚本失败。"));
    }

    Ok((content.into_owned(), document_encoding))
}

fn encode_with_encoding(
    content: &str,
    encoding: &'static encoding_rs::Encoding,
    document_encoding: DocumentEncoding,
    with_bom: bool,
) -> Result<Vec<u8>, String> {
    let (bytes, _, had_errors) = encoding.encode(content);
    if had_errors {
        return Err(format!("将内容编码为 {document_encoding} 失败。"));
    }

    let mut result = Vec::new();
    if with_bom {
        if matches!(document_encoding, DocumentEncoding::Utf16le) {
            result.extend_from_slice(&[0xFF, 0xFE]);
        } else if matches!(document_encoding, DocumentEncoding::Utf16be) {
            result.extend_from_slice(&[0xFE, 0xFF]);
        }
    }
    result.extend_from_slice(bytes.as_ref());
    Ok(result)
}

fn encode_with_encoding_name(content: &str, label: &str) -> Result<Vec<u8>, String> {
    let (bytes, _, had_errors): (Cow<[u8]>, _, bool) = match label {
        "gbk" => encoding_rs::GBK.encode(content),
        "gb18030" => GB18030.encode(content),
        _ => return Err(format!("暂不支持编码：{label}")),
    };
    if had_errors {
        return Err(format!("将内容编码为 {label} 失败。"));
    }
    Ok(bytes.into_owned())
}
