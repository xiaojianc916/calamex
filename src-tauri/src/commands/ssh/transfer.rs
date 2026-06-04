//! SFTP 传输与远程文件操作命令：目录列举、上传/下载、预览读写、删除、重命名、建目录。

use super::SshConnectionParams;
use super::connection::open_authenticated_sftp;
use super::util::{
    decode_remote_preview_text, encode_remote_preview_text, format_remote_permission_from_bits,
    safe_remote_path, truncate_at_utf8_boundary, validate_remote_mutation_name,
};
use crate::commands::{
    SshDirectoryCreatePayload, SshDirectoryCreateRequest, SshDirectoryEntryPayload,
    SshDirectoryListPayload, SshDirectoryListRequest, SshFileDownloadPayload,
    SshFileDownloadRequest, SshFileReadPayload, SshFileReadRequest, SshFileUploadPayload,
    SshFileUploadRequest, SshFileWritePayload, SshFileWriteRequest, SshPathDeletePayload,
    SshPathDeleteRequest, SshPathRenamePayload, SshPathRenameRequest,
};
use jiff::Timestamp;
use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use std::{
    fs as std_fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::time::timeout;

// ---- constants ----
const SSH_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_FILE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);
const SSH_FILE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);
const SSH_FILE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const SFTP_PARTIAL_SUFFIX: &str = ".aster.partial";
const SFTP_BACKUP_SUFFIX: &str = ".aster.backup";
const SFTP_TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const SFTP_PIPELINE_DEPTH: usize = 32;

#[tauri::command]
#[specta::specta]
pub async fn list_ssh_directory(
    payload: SshDirectoryListRequest,
) -> Result<SshDirectoryListPayload, String> {
    let params = SshConnectionParams::from_directory_request(&payload);
    // An empty path means "the default/home directory"; otherwise route through
    // the same `safe_remote_path` hardening every other path-bearing op uses.
    let trimmed = payload.path.trim();
    let effective_path = if trimmed.is_empty() {
        ".".to_string()
    } else {
        safe_remote_path(trimmed).map_err(|e| format!("远程路径不合法：{e}"))?
    };

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = list_dir_inner(&conn.sftp, &effective_path).await;
            let _ = conn.close().await;
            match result {
                Ok(entries) => Ok(SshDirectoryListPayload {
                    path: effective_path,
                    entries,
                }),
                Err(error) => Err(format!("列出 SSH 目录失败：{error}")),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 操作超时。".into()),
    }
}

async fn list_dir_inner(
    sftp: &SftpSession,
    path: &str,
) -> Result<Vec<SshDirectoryEntryPayload>, String> {
    let entries = sftp.read_dir(path).await.map_err(|e| format!("{e}"))?;

    let mut result: Vec<SshDirectoryEntryPayload> = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        let file_type = entry.file_type();
        let kind = if file_type.is_dir() {
            "directory".to_string()
        } else if file_type.is_symlink() {
            "symlink".to_string()
        } else {
            "file".to_string()
        };
        let metadata = entry.metadata();
        let size = metadata.size.unwrap_or(0);
        result.push(SshDirectoryEntryPayload {
            name,
            kind,
            path: entry.path(),
            size,
        });
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn download_ssh_file(
    payload: SshFileDownloadRequest,
) -> Result<SshFileDownloadPayload, String> {
    let params = SshConnectionParams::from_download_request(&payload);
    let remote =
        safe_remote_path(&payload.remote_path).map_err(|e| format!("远程路径不合法：{e}"))?;
    let local = PathBuf::from(&payload.local_path);

    match timeout(SSH_FILE_TRANSFER_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = download_file_inner(&conn.sftp, &remote, &local).await;
            let _ = conn.close().await;
            match result {
                Ok(size) => Ok(SshFileDownloadPayload {
                    remote_path: remote,
                    local_path: local.to_string_lossy().into_owned(),
                    byte_size: size,
                }),
                Err(e) => {
                    cleanup_local_partial(&local);
                    Err(e)
                }
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件下载超时。".into()),
    }
}

async fn download_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
) -> Result<u64, String> {
    let expected_size = sftp.metadata(remote_path).await.ok().and_then(|m| m.size);

    let partial = local_partial_path(local_path);
    let mut file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("无法打开远程文件 {remote_path}：{e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(SFTP_PIPELINE_DEPTH);

    let partial_for_write = partial.clone();
    let write_handle = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let mut local = std_fs::File::create(&partial_for_write)
            .map_err(|e| format!("无法创建本地文件 {partial_for_write:?}：{e}"))?;
        let mut total: u64 = 0;
        while let Some(data) = rx.blocking_recv() {
            local
                .write_all(&data)
                .map_err(|e| format!("写入本地文件失败：{e}"))?;
            total += data.len() as u64;
        }
        local
            .sync_all()
            .map_err(|e| format!("刷新本地文件失败：{e}"))?;
        Ok(total)
    });

    let mut read_error: Option<String> = None;
    let mut buf = vec![0u8; SFTP_TRANSFER_CHUNK_BYTES];
    loop {
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                read_error = Some(format!("读取远程文件失败：{e}"));
                break;
            }
        }
    }
    drop(tx);

    let written = write_handle
        .await
        .map_err(|e| format!("写入任务异常终止：{e}"))??;

    if let Some(e) = read_error {
        return Err(e);
    }

    // 校验下载字节数，防止静默截断（与上传路径保持一致）。
    if let Some(expected) = expected_size {
        ensure_expected_transfer_size(written, expected, "下载远程文件")?;
    }

    let partial_for_rename = partial.clone();
    let target = local_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        std_fs::rename(&partial_for_rename, &target).map_err(|e| format!("重命名本地文件失败：{e}"))
    })
    .await
    .map_err(|e| format!("重命名任务异常终止：{e}"))??;

    Ok(written)
}

#[tauri::command]
#[specta::specta]
pub async fn upload_ssh_file(
    payload: SshFileUploadRequest,
) -> Result<SshFileUploadPayload, String> {
    let params = SshConnectionParams::from_upload_request(&payload);
    let remote =
        safe_remote_path(&payload.remote_directory).map_err(|e| format!("远程路径不合法：{e}"))?;
    let local = PathBuf::from(&payload.local_path);
    let file_size = std_fs::metadata(&local)
        .map_err(|e| format!("无法获取本地文件信息 {local:?}：{e}"))?
        .len();

    match timeout(SSH_FILE_TRANSFER_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = upload_file_inner(&conn.sftp, &remote, &local, file_size).await;
            if result.is_err() {
                cleanup_remote_partial(&conn.sftp, &remote).await;
            }
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshFileUploadPayload {
                    local_path: payload.local_path.clone(),
                    remote_path: remote,
                    byte_size: file_size,
                }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件上传超时。".into()),
    }
}

async fn upload_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &Path,
    file_size: u64,
) -> Result<(), String> {
    let remote_partial = remote_partial_path(remote_path);

    let mut file = sftp
        .open_with_flags(
            &remote_partial,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("无法创建远程文件 {remote_partial}：{e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(SFTP_PIPELINE_DEPTH);
    let local_path_clone = local_path.to_path_buf();

    let read_handle = tokio::task::spawn_blocking(move || {
        let mut local = std_fs::File::open(&local_path_clone)
            .map_err(|e| format!("无法打开本地文件 {local_path_clone:?}：{e}"))?;
        let mut buf = vec![0u8; SFTP_TRANSFER_CHUNK_BYTES];
        loop {
            let n = local
                .read(&mut buf)
                .map_err(|e| format!("读取本地文件失败：{e}"))?;
            if n == 0 {
                break;
            }
            if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                break;
            }
        }
        Ok::<_, String>(())
    });

    let mut written: u64 = 0;
    while let Some(chunk) = rx.recv().await {
        let data = chunk?;
        file.write_all(&data)
            .await
            .map_err(|e| format!("写入远程文件失败：{e}"))?;
        written += data.len() as u64;
    }

    read_handle
        .await
        .map_err(|e| format!("读取任务异常终止：{e}"))?
        .map_err(|e| e.to_string())?;

    file.shutdown()
        .await
        .map_err(|e| format!("关闭远程文件写入失败：{e}"))?;

    ensure_expected_transfer_size(written, file_size, "上传本地文件")?;

    sftp.rename(&remote_partial, remote_path)
        .await
        .map_err(|e| format!("重命名远程文件 {remote_partial} -> {remote_path} 失败：{e}"))?;
    Ok(())
}

fn local_partial_path(local: &Path) -> PathBuf {
    let mut p = local.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    p.set_file_name(format!("{name}{SFTP_PARTIAL_SUFFIX}"));
    p
}

fn remote_partial_path(remote: &str) -> String {
    format!("{remote}{SFTP_PARTIAL_SUFFIX}")
}

fn cleanup_local_partial(local_path: &Path) {
    let partial = local_partial_path(local_path);
    let _ = std_fs::remove_file(partial);
}

async fn cleanup_remote_partial(sftp: &SftpSession, remote_path: &str) {
    let partial = remote_partial_path(remote_path);
    let _ = sftp.remove_file(&partial).await;
}

fn ensure_expected_transfer_size(
    actual: u64,
    expected: u64,
    operation: &str,
) -> Result<(), String> {
    if actual != expected {
        return Err(format!(
            "{operation}大小不一致（预期 {expected} 字节，实际 {actual} 字节）。"
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn read_ssh_file(payload: SshFileReadRequest) -> Result<SshFileReadPayload, String> {
    let params = SshConnectionParams::from_read_request(&payload);
    let remote_path =
        safe_remote_path(&payload.remote_path).map_err(|e| format!("远程路径不合法：{e}"))?;

    match timeout(SSH_FILE_PREVIEW_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = read_file_inner(&conn.sftp, &remote_path).await;
            let _ = conn.close().await;
            result
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件读取超时。".into()),
    }
}

fn preview_read_limit(size: Option<u64>) -> u64 {
    match size {
        Some(size) => SSH_FILE_PREVIEW_MAX_BYTES.min(size.max(1)),
        None => SSH_FILE_PREVIEW_MAX_BYTES,
    }
}

async fn read_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
) -> Result<SshFileReadPayload, String> {
    let metadata = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("无法获取远程文件信息 {remote_path}：{e}"))?;

    let file_size = metadata.size.unwrap_or(0);
    let read_limit = preview_read_limit(metadata.size);

    let mut file = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("无法打开远程文件 {remote_path}：{e}"))?;

    let mut raw: Vec<u8> =
        Vec::with_capacity(read_limit.min(SFTP_TRANSFER_CHUNK_BYTES as u64) as usize);
    let mut buf = vec![0u8; SFTP_TRANSFER_CHUNK_BYTES];
    while (raw.len() as u64) < read_limit {
        let remaining = (read_limit - raw.len() as u64) as usize;
        let take = remaining.min(buf.len());
        let n = file
            .read(&mut buf[..take])
            .await
            .map_err(|e| format!("读取远程文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        raw.extend_from_slice(&buf[..n]);
    }
    let _ = file.shutdown().await;

    let raw = truncate_at_utf8_boundary(raw);

    let (decoded, encoding, line_ending) = decode_remote_preview_text(raw)?;
    let line_count = decoded.lines().count() as u64;

    let permission = metadata
        .permissions
        .map(format_remote_permission_from_bits)
        .unwrap_or_else(|| "---------".into());
    let owner = metadata
        .uid
        .map(|u| u.to_string())
        .unwrap_or_else(|| "0".into());
    let modified_at = metadata.mtime.map(|t| {
        let secs = t as i64;
        Timestamp::from_second(secs)
            .map(|ts| ts.to_string())
            .unwrap_or_default()
    });

    Ok(SshFileReadPayload {
        remote_path: remote_path.into(),
        content: decoded,
        byte_size: file_size,
        encoding,
        line_count,
        line_ending,
        permission,
        owner,
        modified_at,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn write_ssh_file(payload: SshFileWriteRequest) -> Result<SshFileWritePayload, String> {
    let params = SshConnectionParams::from_write_request(&payload);
    let remote_path =
        safe_remote_path(&payload.remote_path).map_err(|e| format!("远程路径不合法：{e}"))?;
    let raw =
        encode_remote_preview_text(&payload.content, &payload.encoding, &payload.line_ending)?;
    let byte_size = raw.len() as u64;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = write_file_inner(&conn.sftp, &remote_path, &raw).await;
            if result.is_err() {
                cleanup_remote_partial(&conn.sftp, &remote_path).await;
            }
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshFileWritePayload {
                    remote_path,
                    byte_size,
                }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 文件写入超时。".into()),
    }
}

async fn write_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    data: &[u8],
) -> Result<(), String> {
    let partial = remote_partial_path(remote_path);
    let mut file = sftp
        .open_with_flags(
            &partial,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("无法创建远程文件 {partial}：{e}"))?;
    file.write_all(data)
        .await
        .map_err(|e| format!("写入远程文件失败：{e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("关闭远程文件写入失败：{e}"))?;

    swap_partial_onto_target(sftp, &partial, remote_path).await
}

async fn swap_partial_onto_target(
    sftp: &SftpSession,
    partial: &str,
    target: &str,
) -> Result<(), String> {
    if sftp.rename(partial, target).await.is_ok() {
        return Ok(());
    }

    let backup = format!("{target}{SFTP_BACKUP_SUFFIX}");
    let had_backup = sftp.rename(target, &backup).await.is_ok();

    match sftp.rename(partial, target).await {
        Ok(()) => {
            if had_backup {
                let _ = sftp.remove_file(&backup).await;
            }
            Ok(())
        }
        Err(e) => {
            if had_backup {
                let _ = sftp.rename(&backup, target).await;
            }
            let _ = sftp.remove_file(partial).await;
            Err(format!("重命名远程文件 {partial} -> {target} 失败：{e}"))
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn delete_ssh_path(
    payload: SshPathDeleteRequest,
) -> Result<SshPathDeletePayload, String> {
    let params = SshConnectionParams::from_delete_request(&payload);
    let remote_path =
        safe_remote_path(&payload.remote_path).map_err(|e| format!("远程路径不合法：{e}"))?;
    validate_remote_mutation_name(&remote_path)?;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = delete_path_inner(&conn.sftp, &remote_path).await;
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshPathDeletePayload { remote_path }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 路径删除超时。".into()),
    }
}

async fn delete_path_inner(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    let meta = sftp.metadata(remote_path).await;
    match meta {
        Ok(attrs) => {
            if attrs.file_type().is_dir() {
                sftp.remove_dir(remote_path)
                    .await
                    .map_err(|e| format!("无法删除远程目录 {remote_path}：{e}"))?;
            } else {
                sftp.remove_file(remote_path)
                    .await
                    .map_err(|e| format!("无法删除远程文件 {remote_path}：{e}"))?;
            }
            Ok(())
        }
        Err(e) => {
            let err_str = e.to_string();
            if err_str.contains("NoSuchFile") || err_str.to_lowercase().contains("no such") {
                Err(format!("远程路径不存在：{remote_path}"))
            } else {
                Err(format!("无法获取远程路径信息 {remote_path}：{e}"))
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn rename_ssh_path(
    payload: SshPathRenameRequest,
) -> Result<SshPathRenamePayload, String> {
    let params = SshConnectionParams::from_rename_request(&payload);
    let old = safe_remote_path(&payload.remote_path).map_err(|e| format!("原路径不合法：{e}"))?;
    let new = safe_remote_path(&payload.new_name).map_err(|e| format!("新路径不合法：{e}"))?;
    validate_remote_mutation_name(&old)?;
    validate_remote_mutation_name(&new)?;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = conn
                .sftp
                .rename(&old, &new)
                .await
                .map_err(|e| format!("重命名远程路径失败：{e}"));
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshPathRenamePayload {
                    old_path: old,
                    new_path: new,
                }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 路径重命名超时。".into()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn create_ssh_directory(
    payload: SshDirectoryCreateRequest,
) -> Result<SshDirectoryCreatePayload, String> {
    let params = SshConnectionParams::from_create_directory_request(&payload);
    let remote_path =
        safe_remote_path(&payload.remote_directory).map_err(|e| format!("远程路径不合法：{e}"))?;

    match timeout(SSH_MUTATION_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = conn
                .sftp
                .create_dir(&remote_path)
                .await
                .map_err(|e| format!("创建远程目录 {remote_path} 失败：{e}"));
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshDirectoryCreatePayload { remote_path }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("SSH 目录创建超时。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_partial_paths_use_stable_suffix() {
        assert_eq!(
            remote_partial_path("/home/app/0.txt"),
            "/home/app/0.txt.aster.partial"
        );
        assert_eq!(
            local_partial_path(Path::new("0.txt")),
            PathBuf::from("0.txt.aster.partial")
        );
    }

    #[test]
    fn ensure_expected_transfer_size_rejects_short_copy() {
        assert!(ensure_expected_transfer_size(8, 8, "上传本地文件").is_ok());
        assert!(ensure_expected_transfer_size(7, 8, "上传本地文件").is_err());
    }

    #[test]
    fn preview_read_limit_handles_unknown_and_known_sizes() {
        assert_eq!(preview_read_limit(None), SSH_FILE_PREVIEW_MAX_BYTES);
        assert_eq!(preview_read_limit(Some(10)), 10);
        assert_eq!(preview_read_limit(Some(0)), 1);
        assert_eq!(
            preview_read_limit(Some(SSH_FILE_PREVIEW_MAX_BYTES + 5)),
            SSH_FILE_PREVIEW_MAX_BYTES
        );
    }
}
