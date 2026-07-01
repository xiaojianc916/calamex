//! AI 附件选择与读取命令（对话框 + 读取均在 Rust 可信侧完成）。
//!
//! 取代前端直连 `@tauri-apps/plugin-fs` 的 `readFile`——后者需能力清单静态授予
//! `fs:allow-read-file` + `fs:scope: "**"`（全盘读），任何注入到 WebView 的脚本都能借此
//! 读取任意文件（如 SSH 私钥 / 浏览器 cookie）。
//!
//! 本命令把「弹对话框 + 读字节」合并在 Rust：前端只能传一个「初始目录提示」，
//! 拿不到、也传不进任何待读取路径——只有用户在原生对话框里亲手选中的文件才会被读。
//! 与 VS Code（主进程持有 showOpenDialog + 读取）/ Zed（Rust 侧对话框+读取）同构，
//! 读取部分与 `workspace_fs::load_image_asset` 同一套校验范式。参见地基审查 S1。

use std::{fs, path::Path};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::Serialize;
use specta::Type;
use tauri_plugin_dialog::DialogExt;

/// AI 附件读取上限：与图片资产同量级，防止一次性读入超大文件耗尽内存 / 撑爆 IPC。
const MAX_ATTACHMENT_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// 单个附件的读取结果：文件名 + base64 编码内容。
///
/// base64 传输避免二进制经 IPC 序列化成 number[] 膨胀；附件属低频操作，编码开销可接受。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentFilePayload {
    pub name: String,
    pub base64: String,
}

/// 一次附件选择的汇总结果：所选文件 + 首个文件所在目录（供前端记忆为下次初始目录）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PickAttachmentFilesPayload {
    pub files: Vec<AttachmentFilePayload>,
    pub picked_dir: Option<String>,
}

/// 弹出原生文件对话框（Rust 可信侧）并把所选附件读回。
///
/// `default_dir` 仅作对话框初始目录提示，不是读取目标；真正被读的只有用户在对话框
/// 里选中的文件。用户取消则返回空列表（与旧前端 open() 取消返回 [] 的语义一致）。
#[tauri::command]
#[specta::specta]
pub async fn pick_attachment_files(
    app: tauri::AppHandle,
    default_dir: Option<String>,
) -> Result<PickAttachmentFilesPayload, String> {
    let mut builder = app.dialog().file();
    if let Some(directory) = default_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.set_directory(directory);
    }

    // pick_files 非阻塞（回调），避免阻塞事件循环 / 主线程；用 oneshot 把结果交回本 async 命令。
    let (tx, rx) = tokio::sync::oneshot::channel();
    builder.pick_files(move |selection| {
        let _ = tx.send(selection);
    });
    let Some(selection) = rx
        .await
        .map_err(|_| "文件选择对话框异常关闭。".to_string())?
    else {
        return Ok(PickAttachmentFilesPayload {
            files: Vec::new(),
            picked_dir: None,
        });
    };

    let mut files = Vec::with_capacity(selection.len());
    let mut picked_dir: Option<String> = None;
    for file_path in selection {
        // simplified() 把 Windows UNC 归一为常规路径；into_path() 处理 Url 变体（桌面平台为 Path）。
        let path = file_path
            .simplified()
            .into_path()
            .map_err(|error| format!("解析所选文件路径失败：{error}"))?;
        let attachment = read_attachment_at(&path)?;
        if picked_dir.is_none() {
            picked_dir = path
                .parent()
                .map(|parent| parent.to_string_lossy().to_string());
        }
        files.push(attachment);
    }

    Ok(PickAttachmentFilesPayload { files, picked_dir })
}

/// 读取单个附件：canonicalize + 拒绝符号链接 + 体积上限，与 load_image_asset 同一套最小授权校验。
fn read_attachment_at(path: &Path) -> Result<AttachmentFilePayload, String> {
    let file_path = path
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
