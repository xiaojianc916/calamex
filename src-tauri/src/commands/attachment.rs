//! AI 附件读取命令。
//!
//! 取代前端直连 `@tauri-apps/plugin-fs` 的 `readFile`——后者需能力清单静态授予
//! `fs:allow-read-file` + `fs:scope: "**"`（全盘读），任何注入到 WebView 的脚本都能借此
//! 读取任意文件（如 SSH 私钥 / 浏览器 cookie）。改由本受限命令出口：canonicalize、拒绝
//! 符号链接、体积上限校验，与 `workspace_fs::load_image_asset` 同一套最小授权范式。
//! 参见地基审查 S1。

use std::{fs, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::Serialize;
use specta::Type;

/// AI 附件读取上限：与图片资产同量级，防止一次性读入超大文件耗尽内存 / 撑爆 IPC。
const MAX_ATTACHMENT_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// 用户经原生文件对话框选中的附件读取结果：文件名 + base64 编码内容。
///
/// base64 传输避免二进制经 IPC 序列化成 number[] 膨胀；附件属低频操作，编码开销可接受。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFilePayload {
    pub name: String,
    pub base64: String,
}

/// 读取用户经原生文件对话框显式选中的附件文件，返回文件名与 base64 编码内容。
///
/// 安全约束（与 `load_image_asset` 一致）：先 `canonicalize` 归一化真实路径，用一次
/// `symlink_metadata` 同时完成「是否常规文件」「大小」检查并拒绝符号链接（避免以附件为名
/// 穿越到软链目标），再校验体积上限。相较此前前端直连 plugin-fs 的通用 `readFile`
/// （可读任意字节的原始能力），本命令是面向「用户刚选中的附件」的受限出口。
#[tauri::command]
#[specta::specta]
pub fn read_attachment_file(path: String) -> Result<AttachmentFilePayload, String> {
    let file_path = PathBuf::from(&path)
        .canonicalize()
        .map_err(|error| format!("读取附件失败：{error}"))?;

    let metadata =
        fs::symlink_metadata(&file_path).map_err(|error| format!("读取附件元数据失败：{error}"))?;

    if metadata.is_symlink() {
        return Err("不支持通过符号链接读取附件。".into());
    }

    if !metadata.is_file() {
        return Err("目标附件不存在或不是有效文件。".into());
    }

    let byte_size = metadata.len();
    if byte_size > MAX_ATTACHMENT_FILE_BYTES {
        return Err(format!(
            "附件过大（{:.1} MB），超过 {} MB 上限，已取消读取。",
            byte_size as f64 / (1024.0 * 1024.0),
            MAX_ATTACHMENT_FILE_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&file_path).map_err(|error| format!("读取附件失败：{error}"))?;
    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();

    Ok(AttachmentFilePayload {
        name,
        base64: BASE64_STANDARD.encode(&bytes),
    })
}
