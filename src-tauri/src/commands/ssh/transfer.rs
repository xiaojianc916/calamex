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
// 建连阶段（连接池获取 + 认证 + SFTP 子系统初始化，含一次无感重试）的超时预算。
// 关键修复：超时此前只裹住 `open_authenticated_sftp`（即建连），真正的传输 / 读写
// 是无界的，链路半死时只能靠 russh keepalive 兜底。现在把「建连」与「操作」拆成两段：
// 建连用本预算，操作本身另用下方对应预算 + `run_with_timeout` 单独限时。
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_FILE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);
const SSH_FILE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);
const SSH_FILE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const SFTP_PARTIAL_SUFFIX: &str = ".aster.partial";
const SFTP_BACKUP_SUFFIX: &str = ".aster.backup";
const SFTP_TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const SFTP_PIPELINE_DEPTH: usize = 32;

/// 在给定预算内运行一个「操作」future，超时则返回带语义的中文错误。
/// future 被丢弃时其内部 channel 随之关闭，附带的 spawn_blocking 任务会自然收尾，
/// 不会泄漏后台线程。
async fn run_with_timeout<T>(
    duration: Duration,
    timeout_message: &str,
    fut: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match timeout(duration, fut).await {
        Ok(inner) => inner,
        Err(_) => Err(timeout_message.to_string()),
    }
}

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

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = run_with_timeout(
                SSH_MUTATION_TIMEOUT,
                "列出 SSH 远端目录超时。",
                list_dir_inner(&conn.sftp, &effective_path),
            )
            .await;
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
        Err(_) => Err("建立 SSH 连接超时。".into()),
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

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = run_with_timeout(
                SSH_FILE_TRANSFER_TIMEOUT,
                "SSH 文件下载超时。",
                download_file_inner(&conn.sftp, &remote, &local),
            )
            .await;
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
        Err(_) => Err("建立 SSH 连接超时。".into()),
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
        if let Some(parent) = partial_for_write.parent()
            && !parent.as_os_str().is_empty()
        {
            std_fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建本地目录 {parent:?}：{e}"))?;
        }
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
    // 主动关闭远程读句柄，及时释放底层 SFTP 通道资源（与 read_file_inner 保持一致），
    // 不必等到函数返回、file 离开作用域时才隐式关闭。
    let _ = file.shutdown().await;

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

    let partial_for_replace = partial.clone();
    let target = local_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        replace_local_partial_onto_target(&partial_for_replace, &target)
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
    let remote_dir =
        safe_remote_path(&payload.remote_directory).map_err(|e| format!("远程路径不合法：{e}"))?;
    let local = PathBuf::from(&payload.local_path);
    // `remote_directory` 语义上是「目标目录」。历史实现直接把它当作目标文件路径，
    // 因此 rename(partial, dir) 必然失败 —— 上传/覆盖从未真正成功过。这里显式地用
    // 本地文件名与目录拼接出真正的目标文件路径。
    let file_name = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| format!("无法从本地路径解析文件名：{}", payload.local_path))?;
    let remote = safe_remote_path(&join_remote_path(&remote_dir, &file_name))
        .map_err(|e| format!("远程路径不合法：{e}"))?;
    validate_remote_mutation_name(&remote)?;
    let file_size = std_fs::metadata(&local)
        .map_err(|e| format!("无法获取本地文件信息 {local:?}：{e}"))?
        .len();

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let remote_partial = remote_partial_path(&remote);
            let result = run_with_timeout(
                SSH_FILE_TRANSFER_TIMEOUT,
                "SSH 文件上传超时。",
                upload_file_inner(&conn.sftp, &remote, &remote_partial, &local, file_size),
            )
            .await;
            if result.is_err() {
                let _ = conn.sftp.remove_file(&remote_partial).await;
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
        Err(_) => Err("建立 SSH 连接超时。".into()),
    }
}

async fn upload_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    remote_partial: &str,
    local_path: &Path,
    file_size: u64,
) -> Result<(), String> {
    let mut file = sftp
        .open_with_flags(
            remote_partial,
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

    // 用安全替换覆盖目标：SFTP rename 在目标已存在时通常直接失败，单纯 rename 既无法
    // 覆盖旧文件，也无法保证原子性。swap 会在替换失败时回滚到原文件。
    swap_partial_onto_target(sftp, remote_partial, remote_path).await
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

fn local_backup_path(local: &Path) -> PathBuf {
    let mut p = local.to_path_buf();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    p.set_file_name(format!(
        "{name}.{token}{SFTP_BACKUP_SUFFIX}",
        token = unique_transfer_token()
    ));
    p
}

/// 生成进程内唯一的传输令牌（pid + 纳秒时间戳 + 单调计数器）。
/// 用于远端临时 / 备份文件名，避免并发上传或写入时固定后缀互相覆盖。
fn unique_transfer_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let pid = std::process::id();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{pid}.{nanos}.{counter}")
}

/// 把目标目录与文件名拼成远端目标文件路径，统一去除目录尾部多余的 `/`。
fn join_remote_path(dir: &str, name: &str) -> String {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() {
        format!("/{name}")
    } else {
        format!("{trimmed}/{name}")
    }
}

/// 解析“在原路径所在目录内改名”的目标路径。
///
/// 前端传入的是 newName，而不是完整 newPath。旧实现直接 rename(old, newName)，
/// 会把 /home/app/a.txt -> b.txt 解释成服务端当前工作目录下的 b.txt，导致文件
/// 被挪到错误位置。这里对纯文件名保持 sibling rename；若调用方已经传入完整路径，
/// 则保留完整路径语义。
fn resolve_rename_target_path(old_path: &str, raw_new_name: &str) -> Result<String, String> {
    let new_path = safe_remote_path(raw_new_name).map_err(|e| format!("新路径不合法：{e}"))?;
    validate_remote_mutation_name(&new_path)?;

    if new_path.contains('/') {
        return Ok(new_path);
    }

    let target = match old_path.rsplit_once('/') {
        Some(("", _)) => format!("/{new_path}"),
        Some((parent, _)) => join_remote_path(parent, &new_path),
        None => new_path,
    };
    validate_remote_mutation_name(&target)?;
    Ok(target)
}

/// 解析“在当前目录下创建 name”的最终目录路径。
///
/// 为兼容旧调用方：如果 name 为空，则 remote_directory 仍被视为完整目标路径。
fn resolve_create_directory_path(remote_directory: &str, name: &str) -> Result<String, String> {
    let parent = safe_remote_path(remote_directory).map_err(|e| format!("远程路径不合法：{e}"))?;
    let name = name.trim();

    if name.is_empty() {
        validate_remote_mutation_name(&parent)?;
        return Ok(parent);
    }

    if name.contains('/') || name.contains('\\') {
        return Err("目录名称不能包含路径分隔符。".into());
    }

    validate_remote_mutation_name(name)?;
    let target = safe_remote_path(&join_remote_path(&parent, name))
        .map_err(|e| format!("远程路径不合法：{e}"))?;
    validate_remote_mutation_name(&target)?;
    Ok(target)
}

fn remote_partial_path(remote: &str) -> String {
    format!("{remote}.{}{SFTP_PARTIAL_SUFFIX}", unique_transfer_token())
}

fn remote_backup_path(target: &str) -> String {
    format!("{target}.{}{SFTP_BACKUP_SUFFIX}", unique_transfer_token())
}

fn cleanup_local_partial(local_path: &Path) {
    let partial = local_partial_path(local_path);
    let _ = std_fs::remove_file(partial);
}

fn replace_local_partial_onto_target(partial: &Path, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent()
        && !parent.as_os_str().is_empty()
    {
        std_fs::create_dir_all(parent).map_err(|e| format!("无法创建本地目录 {parent:?}：{e}"))?;
    }

    if std_fs::rename(partial, target).is_ok() {
        return Ok(());
    }

    let backup = local_backup_path(target);
    let had_backup = if target.exists() {
        std_fs::rename(target, &backup)
            .map_err(|e| format!("无法备份已有本地文件 {target:?} -> {backup:?}：{e}"))?;
        true
    } else {
        false
    };

    match std_fs::rename(partial, target) {
        Ok(()) => {
            if had_backup {
                let _ = std_fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(error) => {
            if had_backup {
                let _ = std_fs::rename(&backup, target);
            }
            Err(format!(
                "重命名本地文件 {partial:?} -> {target:?} 失败：{error}"
            ))
        }
    }
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

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = run_with_timeout(
                SSH_FILE_PREVIEW_TIMEOUT,
                "SSH 文件读取超时。",
                read_file_inner(&conn.sftp, &remote_path),
            )
            .await;
            let _ = conn.close().await;
            result
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("建立 SSH 连接超时。".into()),
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

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let partial = remote_partial_path(&remote_path);
            let result = run_with_timeout(
                SSH_MUTATION_TIMEOUT,
                "SSH 文件写入超时。",
                write_file_inner(&conn.sftp, &remote_path, &partial, &raw),
            )
            .await;
            if result.is_err() {
                let _ = conn.sftp.remove_file(&partial).await;
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
        Err(_) => Err("建立 SSH 连接超时。".into()),
    }
}

async fn write_file_inner(
    sftp: &SftpSession,
    remote_path: &str,
    partial: &str,
    data: &[u8],
) -> Result<(), String> {
    let mut file = sftp
        .open_with_flags(
            partial,
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

    swap_partial_onto_target(sftp, partial, remote_path).await
}

async fn swap_partial_onto_target(
    sftp: &SftpSession,
    partial: &str,
    target: &str,
) -> Result<(), String> {
    if sftp.rename(partial, target).await.is_ok() {
        return Ok(());
    }

    let backup = remote_backup_path(target);
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

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = run_with_timeout(
                SSH_MUTATION_TIMEOUT,
                "删除 SSH 远端路径超时。",
                delete_path_inner(&conn.sftp, &remote_path),
            )
            .await;
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshPathDeletePayload { remote_path }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("建立 SSH 连接超时。".into()),
    }
}

async fn delete_path_inner(sftp: &SftpSession, remote_path: &str) -> Result<(), String> {
    let meta = sftp.metadata(remote_path).await;
    match meta {
        Ok(attrs) => {
            if attrs.file_type().is_dir() {
                // SFTP rmdir 在非空目录上会失败且报错晦涩。这里先探测目录内容：
                // 非空时给出清晰中文提示，并明确「不做递归删除」以避免误删整目录。
                let children = sftp
                    .read_dir(remote_path)
                    .await
                    .map_err(|e| format!("无法读取远程目录内容 {remote_path}：{e}"))?;
                let child_count = children
                    .into_iter()
                    .filter(|entry| {
                        let name = entry.file_name();
                        name != "." && name != ".."
                    })
                    .count();
                if child_count > 0 {
                    return Err(format!(
                        "远程目录非空（包含 {child_count} 个项目），为避免误删不会递归删除；请先清空目录内容后再删除：{remote_path}"
                    ));
                }
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
    validate_remote_mutation_name(&old)?;
    let new = resolve_rename_target_path(&old, &payload.new_name)?;

    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result = run_with_timeout(
                SSH_MUTATION_TIMEOUT,
                "重命名 SSH 远端路径超时。",
                async {
                    conn.sftp
                        .rename(&old, &new)
                        .await
                        .map_err(|e| format!("重命名远程路径失败：{e}"))
                },
            )
            .await;
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
        Err(_) => Err("建立 SSH 连接超时。".into()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn create_ssh_directory(
    payload: SshDirectoryCreateRequest,
) -> Result<SshDirectoryCreatePayload, String> {
    let params = SshConnectionParams::from_create_directory_request(&payload);
    let remote_path = resolve_create_directory_path(&payload.remote_directory, "")?;
    match timeout(SSH_CONNECT_TIMEOUT, open_authenticated_sftp(&params)).await {
        Ok(Ok(conn)) => {
            let result =
                run_with_timeout(SSH_MUTATION_TIMEOUT, "创建 SSH 远端目录超时。", async {
                    conn.sftp
                        .create_dir(&remote_path)
                        .await
                        .map_err(|e| format!("创建远程目录 {remote_path} 失败：{e}"))
                })
                .await;
            let _ = conn.close().await;
            match result {
                Ok(()) => Ok(SshDirectoryCreatePayload { remote_path }),
                Err(e) => Err(e),
            }
        }
        Ok(Err(error)) => Err(error),
        Err(_) => Err("建立 SSH 连接超时。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_partial_and_backup_paths_are_unique_with_expected_shape() {
        let a = remote_partial_path("/home/app/0.txt");
        let b = remote_partial_path("/home/app/0.txt");
        assert!(a.starts_with("/home/app/0.txt."));
        assert!(a.ends_with(SFTP_PARTIAL_SUFFIX));
        assert_ne!(a, b, "并发临时文件名应互不相同");

        let backup = remote_backup_path("/home/app/0.txt");
        assert!(backup.starts_with("/home/app/0.txt."));
        assert!(backup.ends_with(SFTP_BACKUP_SUFFIX));

        // 本地分片后缀保持稳定（下载为单线程、碰撞概率极低）。
        assert_eq!(
            local_partial_path(Path::new("0.txt")),
            PathBuf::from("0.txt.aster.partial")
        );
    }

    #[test]
    fn join_remote_path_builds_target_file_path() {
        assert_eq!(join_remote_path("/home/app", "0.txt"), "/home/app/0.txt");
        assert_eq!(join_remote_path("/home/app/", "0.txt"), "/home/app/0.txt");
        assert_eq!(join_remote_path("/", "0.txt"), "/0.txt");
        assert_eq!(join_remote_path(".", "0.txt"), "./0.txt");
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

    #[test]
    fn ssh_rename_and_create_directory_paths_resolve_to_expected_targets() {
        assert_eq!(
            resolve_rename_target_path("/home/app/old.txt", "new.txt").unwrap(),
            "/home/app/new.txt"
        );
        assert_eq!(
            resolve_rename_target_path("/old.txt", "new.txt").unwrap(),
            "/new.txt"
        );
        assert_eq!(
            resolve_rename_target_path("/home/app/old.txt", "/tmp/new.txt").unwrap(),
            "/tmp/new.txt"
        );

        assert_eq!(
            resolve_create_directory_path("/home/app", "logs").unwrap(),
            "/home/app/logs"
        );
        assert_eq!(
            resolve_create_directory_path("/home/app/", "logs").unwrap(),
            "/home/app/logs"
        );
        assert!(resolve_create_directory_path("/home/app", "../bad").is_err());
    }

    #[tokio::test]
    async fn run_with_timeout_returns_inner_result_when_fast() {
        let ok = run_with_timeout(Duration::from_secs(5), "超时", async {
            Ok::<_, String>(7u8)
        })
        .await;
        assert_eq!(ok, Ok(7));

        let err = run_with_timeout(Duration::from_secs(5), "超时", async {
            Err::<u8, String>("内部错误".into())
        })
        .await;
        assert_eq!(err, Err("内部错误".to_string()));
    }

    #[tokio::test]
    async fn run_with_timeout_maps_elapsed_to_message() {
        let res = run_with_timeout(Duration::from_millis(10), "操作超时。", async {
            tokio::time::sleep(Duration::from_secs(30)).await;
            Ok::<_, String>(())
        })
        .await;
        assert_eq!(res, Err("操作超时。".to_string()));
    }

    #[test]
    fn local_backup_path_keeps_target_parent_and_suffix() {
        let target = Path::new("dir").join("download.txt");
        let backup = local_backup_path(&target);
        assert_eq!(backup.parent(), Some(Path::new("dir")));
        let name = backup
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        assert!(name.starts_with("download.txt."));
        assert!(name.ends_with(SFTP_BACKUP_SUFFIX));
    }
}
