use super::{
    DocumentEncoding, ImageAssetPayload, SaveScriptRequest, ScriptFilePayload,
    WorkspaceDirectoryPayload, WorkspaceEntry, WorkspacePathCreatePayload,
    WorkspacePathCreateRequest, WorkspacePathDeletePayload, WorkspacePathDeleteRequest,
    WorkspacePathKind, WorkspacePathRenamePayload, WorkspacePathRenameRequest, line_count,
};
use atomic_write_file::AtomicWriteFile;
use encoding_rs::{GB18030, UTF_8, UTF_16BE, UTF_16LE};
use std::{
    borrow::Cow,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::Manager;

/// 脚本文件读取上限：超过则拒绝在编辑器中打开，避免一次性读入超大文件耗尽内存。
const MAX_SCRIPT_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// 图片资源大小上限：改用 asset 协议流式加载后不再 base64 膨胀，这里仅作为防御性的体积保护。
const MAX_IMAGE_ASSET_BYTES: u64 = 20 * 1024 * 1024;

#[tauri::command]
#[specta::specta]
pub fn load_script(
    path: String,
    workspace_root_path: Option<String>,
) -> Result<ScriptFilePayload, String> {
    let file_path = resolve_script_file_path(&path, workspace_root_path)?;
    ensure_within_size_limit(&file_path, MAX_SCRIPT_FILE_BYTES, "脚本")?;
    let bytes = fs::read(&file_path).map_err(|error| format!("读取脚本失败：{error}"))?;
    let (content, encoding) = decode_script_bytes(&bytes)?;
    build_script_payload(file_path, content, encoding)
}

#[tauri::command]
#[specta::specta]
pub fn load_image_asset(app: tauri::AppHandle, path: String) -> Result<ImageAssetPayload, String> {
    let file_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("读取图片资源失败：{error}"))?;

    if !file_path.is_file() {
        return Err("目标图片不存在或不是有效文件。".into());
    }

    let byte_size = ensure_within_size_limit(&file_path, MAX_IMAGE_ASSET_BYTES, "图片资源")?;

    // 仅把当前预览的这一个文件加入 asset 协议作用域，前端通过 convertFileSrc 按需流式读取：
    // 既避免把整张图 base64 编码后经 IPC 传输（约 1.37 倍膨胀 + 巨大 JS 字符串），
    // 又把可访问面收敛到“确实打开过的图片”，保持最小授权。
    app.asset_protocol_scope()
        .allow_file(&file_path)
        .map_err(|error| format!("授权图片资源访问失败：{error}"))?;

    build_image_asset_payload(file_path, byte_size)
}

#[tauri::command]
#[specta::specta]
pub fn save_script(payload: SaveScriptRequest) -> Result<ScriptFilePayload, String> {
    let file_path = resolve_save_script_path(&payload.path, payload.workspace_root_path)?;
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
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target_path)
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::AlreadyExists {
                        "同名文件或文件夹已存在。".to_string()
                    } else {
                        format!("创建文件失败：{error}")
                    }
                })?;
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

fn resolve_script_file_path(
    raw_path: &str,
    workspace_root_path: Option<String>,
) -> Result<PathBuf, String> {
    let file_path = PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|error| format!("读取脚本失败：{error}"))?;

    if !file_path.is_file() {
        return Err("目标脚本不存在或不是有效文件。".into());
    }

    ensure_optional_workspace_boundary(&file_path, workspace_root_path)
}

fn resolve_save_script_path(
    raw_path: &str,
    workspace_root_path: Option<String>,
) -> Result<PathBuf, String> {
    // 先拆出文件名与父目录（缺省父目录视为当前目录），创建父目录后再对父目录做
    // canonicalize，使最终写入路径中的 `..` 等被解析为真实目录，避免路径穿越写盘。
    let raw_path = PathBuf::from(raw_path);
    let file_name = raw_path
        .file_name()
        .ok_or_else(|| "无法解析目标文件名。".to_string())?
        .to_owned();
    let parent = raw_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    fs::create_dir_all(&parent).map_err(|error| format!("创建目录失败：{error}"))?;

    let file_path = parent
        .canonicalize()
        .map_err(|error| format!("解析目标目录失败：{error}"))?
        .join(&file_name);

    ensure_optional_workspace_boundary(&file_path, workspace_root_path)
}

fn ensure_optional_workspace_boundary(
    file_path: &Path,
    workspace_root_path: Option<String>,
) -> Result<PathBuf, String> {
    let Some(workspace_root_path) = workspace_root_path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(file_path.to_path_buf());
    };

    let workspace_root = resolve_workspace_root(Some(workspace_root_path))?;
    if !file_path.starts_with(&workspace_root) {
        return Err("仅允许读写当前资源根目录内的脚本文件。".into());
    }

    Ok(file_path.to_path_buf())
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
    let name = raw_name.trim_start();
    if name.is_empty() {
        return Err("名称不能为空。".into());
    }

    if name == "." || name == ".." {
        return Err("名称不能为 . 或 ..。".into());
    }

    if name.ends_with([' ', '.']) {
        return Err("名称不能以空格或点结尾。".into());
    }

    if is_windows_reserved_device_name(name) {
        return Err("名称不能使用 Windows 保留设备名。".into());
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

fn is_windows_reserved_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();

    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// 校验文件大小未超过上限并返回其字节数，避免一次性读入超大文件耗尽内存。
fn ensure_within_size_limit(path: &Path, max_bytes: u64, label: &str) -> Result<u64, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("读取{label}失败：{error}"))?;
    let byte_size = metadata.len();
    if byte_size > max_bytes {
        return Err(format!(
            "{label}过大（{:.1} MB），超过 {} MB 上限，已取消读取。",
            byte_size as f64 / (1024.0 * 1024.0),
            max_bytes / (1024 * 1024)
        ));
    }
    Ok(byte_size)
}

/// 原子写入：由 atomic-write-file 在目标同目录创建唯一临时文件，完整写入后 commit 覆盖目标，
/// 避免固定临时文件名在并发保存时互相覆盖 / 删除导致静默丢数据。
fn atomic_write(file_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = AtomicWriteFile::options()
        .open(file_path)
        .map_err(|error| format!("保存脚本失败：{error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("保存脚本失败：{error}"))?;
    file.commit()
        .map_err(|error| format!("保存脚本失败：{error}"))
}

pub(crate) fn decode_script_bytes(bytes: &[u8]) -> Result<(String, DocumentEncoding), String> {
    // 优先用 encoding_rs 官方 BOM 嗅探替代手写的字节前缀比较：
    // `for_bom` 返回 (编码, BOM 字节数)，据此映射到内部编码并在剥掉 BOM 后解码。
    if let Some((encoding, bom_length)) = encoding_rs::Encoding::for_bom(bytes) {
        let document_encoding = bom_document_encoding(encoding)?;
        return decode_with_encoding(&bytes[bom_length..], encoding, document_encoding);
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

/// 把 `encoding_rs::Encoding::for_bom` 嗅探到的编码映射为内部 `DocumentEncoding`。
///
/// `for_bom` 仅会返回 UTF-8 / UTF-16LE / UTF-16BE 三种带 BOM 的编码，这里据此映射；
/// 其余分支仅作防御，正常不会命中。
fn bom_document_encoding(
    encoding: &'static encoding_rs::Encoding,
) -> Result<DocumentEncoding, String> {
    if encoding == UTF_8 {
        Ok(DocumentEncoding::Utf8Bom)
    } else if encoding == UTF_16LE {
        Ok(DocumentEncoding::Utf16le)
    } else if encoding == UTF_16BE {
        Ok(DocumentEncoding::Utf16be)
    } else {
        Err("无法识别文件 BOM 对应的编码。".into())
    }
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

fn build_image_asset_payload(path: PathBuf, byte_size: u64) -> Result<ImageAssetPayload, String> {
    let mime_type = resolve_image_mime_type(&path)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .to_string();

    Ok(ImageAssetPayload {
        path: path.to_string_lossy().to_string(),
        name,
        mime_type,
        byte_size: count_to_u32(byte_size as usize, "图片字节数")?,
    })
}

fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

fn resolve_image_mime_type(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "无法识别图片格式。".to_string())?;

    let mime_type = mime_guess::from_path(path)
        .first()
        .ok_or_else(|| format!("暂不支持预览该图片格式：{extension}"))?;

    if mime_type.type_() != mime_guess::mime::IMAGE {
        return Err(format!("暂不支持预览该图片格式：{extension}"));
    }

    Ok(mime_type.essence_str().to_string())
}

fn is_workspace_directory_entry(path: &Path, file_type: &fs::FileType) -> bool {
    file_type.is_dir() || fs::metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

fn read_workspace_entries(directory: &Path) -> Result<Vec<WorkspaceEntry>, String> {
    let read_dir = fs::read_dir(directory).map_err(|error| format!("读取资源目录失败：{error}"))?;
    let mut entries = Vec::new();
    let (minimum_entry_count, _) = read_dir.size_hint();
    entries.reserve(minimum_entry_count);

    for item in read_dir {
        let entry = item.map_err(|error| format!("读取资源目录项失败：{error}"))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取资源类型失败：{error}"))?;
        let is_directory = is_workspace_directory_entry(&path, &file_type);

        entries.push(WorkspaceEntry {
            path: path.to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            kind: if is_directory {
                WorkspacePathKind::Directory
            } else {
                WorkspacePathKind::File
            },
            // 懒加载：只要是目录就给出可展开提示，不再为每个子目录预读一次 read_dir，
            // 大目录树首屏明显更快。空目录会显示展开箭头但展开为空，是文件树的标准取舍。
            has_children: is_directory,
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

#[cfg(test)]
mod tests {
    use super::{
        atomic_write, decode_script_bytes, read_workspace_entries, resolve_image_mime_type,
        resolve_save_script_path, resolve_script_file_path,
    };
    use std::{fs, path::Path, thread};

    #[test]
    fn decodes_utf8_bom_and_strips_marker() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("echo hi".as_bytes());
        let (content, encoding) = decode_script_bytes(&bytes).expect("decode utf-8 bom");
        assert_eq!(content, "echo hi");
        assert_eq!(encoding.as_str(), "utf-8-bom");
    }

    #[test]
    fn decodes_utf16le_bom() {
        let bytes = [0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00];
        let (content, encoding) = decode_script_bytes(&bytes).expect("decode utf-16le bom");
        assert_eq!(content, "Hi");
        assert_eq!(encoding.as_str(), "utf-16le");
    }

    #[test]
    fn decodes_utf16be_bom() {
        let bytes = [0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69];
        let (content, encoding) = decode_script_bytes(&bytes).expect("decode utf-16be bom");
        assert_eq!(content, "Hi");
        assert_eq!(encoding.as_str(), "utf-16be");
    }

    #[test]
    fn decodes_plain_utf8_without_bom() {
        let (content, encoding) =
            decode_script_bytes("echo hi".as_bytes()).expect("decode plain utf-8");
        assert_eq!(content, "echo hi");
        assert_eq!(encoding.as_str(), "utf-8");
    }

    #[test]
    fn falls_back_to_gb18030_for_non_utf8_bytes() {
        // GB18030 编码的“中”（0xD6 0xD0）不是合法 UTF-8，且不含 BOM / NUL，应回退到 GB18030。
        let bytes = [0xD6, 0xD0];
        let (content, encoding) = decode_script_bytes(&bytes).expect("decode gb18030");
        assert_eq!(content, "中");
        assert_eq!(encoding.as_str(), "gb18030");
    }

    #[test]
    fn rejects_binary_content_with_nul_byte() {
        let bytes = [0x68, 0x00, 0x69];
        let error = decode_script_bytes(&bytes).expect_err("binary content should be rejected");
        assert!(error.contains("二进制"));
    }

    #[test]
    fn resolves_image_mime_types_with_mime_guess() {
        for (path, expected) in [
            ("preview.png", "image/png"),
            ("preview.jpg", "image/jpeg"),
            ("preview.svg", "image/svg+xml"),
            ("preview.avif", "image/avif"),
        ] {
            let mime_type = resolve_image_mime_type(Path::new(path)).expect("image mime");
            assert_eq!(mime_type, expected);
        }
    }

    #[test]
    fn rejects_non_image_mime_types_from_mime_guess() {
        let error = resolve_image_mime_type(Path::new("script.sh"))
            .expect_err("non-image mime should be rejected");
        assert!(error.contains("暂不支持预览该图片格式：sh"));
    }

    #[test]
    fn rejects_reserved_workspace_entry_names() {
        for name in ["CON", "con.txt", "NUL", "COM1", "LPT9.md"] {
            let error = super::validate_workspace_entry_name(name)
                .expect_err("reserved device name should be rejected");
            assert!(error.contains("Windows 保留设备名"));
        }
    }

    #[test]
    fn rejects_trailing_space_or_dot_workspace_entry_names() {
        for name in ["foo.", "foo "] {
            let error = super::validate_workspace_entry_name(name)
                .expect_err("trailing space/dot should be rejected");
            assert!(error.contains("空格或点"));
        }
    }

    #[test]
    fn rejects_workspace_script_reads_outside_root() {
        let test_dir = std::env::temp_dir().join(format!(
            "calamex-script-boundary-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        let workspace_root = test_dir.join("workspace");
        let outside_root = test_dir.join("outside");
        fs::create_dir_all(&workspace_root).expect("create workspace dir");
        fs::create_dir_all(&outside_root).expect("create outside dir");
        let outside_file = outside_root.join("script.sh");
        fs::write(&outside_file, "echo outside\n").expect("write outside file");

        let error = resolve_script_file_path(
            &outside_file.to_string_lossy(),
            Some(workspace_root.to_string_lossy().to_string()),
        )
        .expect_err("outside file should be rejected");

        assert!(error.contains("仅允许读写当前资源根目录内的脚本文件"));
        fs::remove_dir_all(test_dir).expect("remove temp dir");
    }

    #[test]
    fn rejects_workspace_script_writes_outside_root() {
        let test_dir = std::env::temp_dir().join(format!(
            "calamex-save-boundary-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        let workspace_root = test_dir.join("workspace");
        let outside_root = test_dir.join("outside");
        fs::create_dir_all(&workspace_root).expect("create workspace dir");
        fs::create_dir_all(&outside_root).expect("create outside dir");

        let error = resolve_save_script_path(
            &outside_root.join("script.sh").to_string_lossy(),
            Some(workspace_root.to_string_lossy().to_string()),
        )
        .expect_err("outside save target should be rejected");

        assert!(error.contains("仅允许读写当前资源根目录内的脚本文件"));
        fs::remove_dir_all(test_dir).expect("remove temp dir");
    }

    #[test]
    fn read_workspace_entries_classifies_real_directories() {
        let test_dir = std::env::temp_dir().join(format!(
            "calamex-workspace-dir-kind-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        let directory = test_dir.join(".calamex-skills");
        fs::create_dir_all(&directory).expect("create directory");

        let entries = read_workspace_entries(&test_dir).expect("read workspace entries");
        let entry = entries
            .iter()
            .find(|entry| entry.name == ".calamex-skills")
            .expect("directory entry exists");

        assert_eq!(entry.kind.as_str(), "directory");
        assert!(entry.has_children);

        fs::remove_dir_all(test_dir).expect("remove temp dir");
    }

    #[cfg(unix)]
    #[test]
    fn read_workspace_entries_follows_directory_symlinks() {
        let test_dir = std::env::temp_dir().join(format!(
            "calamex-workspace-symlink-kind-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        let target = test_dir.join("target-dir");
        let link = test_dir.join("linked-dir");
        fs::create_dir_all(&target).expect("create target directory");
        std::os::unix::fs::symlink(&target, &link).expect("create directory symlink");

        let entries = read_workspace_entries(&test_dir).expect("read workspace entries");
        let entry = entries
            .iter()
            .find(|entry| entry.name == "linked-dir")
            .expect("symlink entry exists");

        assert_eq!(entry.kind.as_str(), "directory");
        assert!(entry.has_children);

        fs::remove_dir_all(test_dir).expect("remove temp dir");
    }

    #[test]
    fn atomic_write_allows_concurrent_writers_without_fixed_temp_collision() {
        let test_dir = std::env::temp_dir().join(format!(
            "calamex-atomic-write-{}",
            jiff::Timestamp::now().as_nanosecond()
        ));
        fs::create_dir_all(&test_dir).expect("create temp dir");
        let file_path = test_dir.join("script.sh");

        let handles = (0..8)
            .map(|index| {
                let file_path = file_path.clone();
                thread::spawn(move || {
                    atomic_write(&file_path, format!("echo {index}\n").as_bytes())
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle
                .join()
                .expect("writer thread panicked")
                .expect("writer failed");
        }

        let content = fs::read_to_string(&file_path).expect("read final file");
        assert!(content.starts_with("echo "));
        assert!(!test_dir.join(".script.sh.tmp").exists());

        fs::remove_dir_all(test_dir).expect("remove temp dir");
    }
}
