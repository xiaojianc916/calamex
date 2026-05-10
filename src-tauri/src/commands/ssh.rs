use super::{
    SshConfigHostPayload, SshConnectionTestPayload, SshConnectionTestRequest,
    SshDirectoryCreatePayload, SshDirectoryCreateRequest, SshDirectoryEntryPayload,
    SshDirectoryListPayload, SshDirectoryListRequest, SshFileDownloadPayload,
    SshFileDownloadRequest, SshFileReadPayload, SshFileReadRequest, SshFileUploadPayload,
    SshFileUploadRequest, SshPasswordGetRequest, SshPasswordPayload, SshPasswordSaveRequest,
    SshPasswordStatusPayload, SshPathDeletePayload, SshPathDeleteRequest, SshPathRenamePayload,
    SshPathRenameRequest,
};
use ssh2::{FileStat, OpenFlags, OpenType, RenameFlags, Session, Sftp};
use std::{
    env, fs as std_fs,
    io::{Read, Seek, SeekFrom, Write},
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{fs as tokio_fs, task, time::timeout};

const SSH_CONNECT_TIMEOUT_SECONDS: u64 = 8;
const SSH_TEST_TIMEOUT: Duration = Duration::from_secs(12);
const SSH_MUTATION_TIMEOUT: Duration = Duration::from_secs(30);
const SSH_FILE_TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);
const SSH_FILE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(60);
const SSH_FILE_PREVIEW_MAX_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_SSH_PORT: u16 = 22;
const SSH_KEYRING_SERVICE: &str = "calamex.ssh";
const SSH_CONFIG_IMPORTED_LABEL: &str = "SSH config";
const SFTP_PARTIAL_SUFFIX: &str = ".aster.partial";
const SFTP_TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;

#[derive(Debug, Clone)]
struct SshConnectionParams {
    host: String,
    port: u16,
    username: String,
    auth_mode: String,
    identity_path: Option<String>,
    password: Option<String>,
}

impl SshConnectionParams {
    fn from_test_request(payload: &SshConnectionTestRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_directory_request(payload: &SshDirectoryListRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_download_request(payload: &SshFileDownloadRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_upload_request(payload: &SshFileUploadRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_delete_request(payload: &SshPathDeleteRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_rename_request(payload: &SshPathRenameRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_create_directory_request(payload: &SshDirectoryCreateRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }

    fn from_read_request(payload: &SshFileReadRequest) -> Self {
        Self {
            host: payload.host.trim().into(),
            port: payload.port,
            username: payload.username.trim().into(),
            auth_mode: payload.auth_mode.clone(),
            identity_path: payload.identity_path.clone(),
            password: payload.password.clone(),
        }
    }
}

#[tauri::command]
pub async fn test_ssh_connection(
    payload: SshConnectionTestRequest,
) -> Result<SshConnectionTestPayload, String> {
    let params = SshConnectionParams::from_test_request(&payload);
    if params.host.is_empty() {
        return Ok(failed("ssh/invalid-host", "请填写主机地址。"));
    }
    if params.username.is_empty() {
        return Ok(failed("ssh/invalid-username", "请填写用户名。"));
    }
    if let Err(message) = validate_ssh_endpoint(&params.host, &params.username) {
        return Ok(failed("ssh/invalid-target", &message));
    }
    if params.auth_mode != "key" && params.auth_mode != "password" {
        return Ok(failed("ssh/invalid-auth-mode", "不支持的 SSH 认证方式。"));
    }
    if params.auth_mode == "password"
        && params
            .password
            .as_deref()
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Ok(failed("ssh/password-missing", "请填写 SSH 登录密码。"));
    }

    match timeout(
        SSH_TEST_TIMEOUT,
        task::spawn_blocking(move || open_authenticated_session(&params).map(|_| ())),
    )
    .await
    {
        Ok(Ok(Ok(()))) => Ok(SshConnectionTestPayload {
            ok: true,
            code: "ssh/ok".into(),
            message: "SSH 连接验证成功。".into(),
        }),
        Ok(Ok(Err(error))) => Ok(failed(
            &classify_ssh_error(&error),
            &format_ssh_error_message(&error),
        )),
        Ok(Err(error)) => Ok(failed(
            "ssh/spawn-failed",
            &format!("启动 SSH 连接任务失败：{error}"),
        )),
        Err(_) => Ok(failed("ssh/timeout", "SSH 连接测试超时。")),
    }
}

#[tauri::command]
pub async fn list_ssh_config_hosts() -> Result<Vec<SshConfigHostPayload>, String> {
    let Some(config_path) = default_ssh_config_path() else {
        return Ok(Vec::new());
    };

    let content = match tokio_fs::read_to_string(&config_path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("读取 SSH 配置失败：{error}")),
    };

    Ok(parse_ssh_config_hosts(&content))
}

#[tauri::command]
pub fn save_ssh_password(
    payload: SshPasswordSaveRequest,
) -> Result<SshPasswordStatusPayload, String> {
    let account = ssh_password_account(&payload.host, payload.port, &payload.username)?;
    let password = payload.password.expose();
    if password.is_empty() {
        return Err("SSH 密码不能为空。".into());
    }

    keyring::Entry::new(SSH_KEYRING_SERVICE, &account)
        .map_err(|error| format!("打开系统凭据库失败：{error}"))?
        .set_password(password)
        .map_err(|error| format!("保存 SSH 密码失败：{error}"))?;

    Ok(SshPasswordStatusPayload { has_password: true })
}

#[tauri::command]
pub fn get_ssh_password(payload: SshPasswordGetRequest) -> Result<SshPasswordPayload, String> {
    let account = ssh_password_account(&payload.host, payload.port, &payload.username)?;
    let password = keyring::Entry::new(SSH_KEYRING_SERVICE, &account)
        .map_err(|error| format!("打开系统凭据库失败：{error}"))?
        .get_password()
        .map_err(|_| "未找到该 SSH 连接的已保存密码，请重新输入并连接一次。".to_string())?;

    if password.is_empty() {
        return Err("该 SSH 连接的已保存密码为空，请重新输入并连接一次。".into());
    }

    Ok(SshPasswordPayload { password })
}

#[tauri::command]
pub async fn list_ssh_directory(
    payload: SshDirectoryListRequest,
) -> Result<SshDirectoryListPayload, String> {
    let params = SshConnectionParams::from_directory_request(&payload);
    let remote_path = normalize_remote_path(&payload.path);
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    validate_remote_path(&remote_path)?;

    match timeout(
        SSH_TEST_TIMEOUT,
        task::spawn_blocking(move || list_sftp_directory(&params, &remote_path)),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("读取远端目录任务失败：{error}")),
        Err(_) => Err("读取远端目录超时。".into()),
    }
}

#[tauri::command]
pub async fn download_ssh_file(
    payload: SshFileDownloadRequest,
) -> Result<SshFileDownloadPayload, String> {
    let params = SshConnectionParams::from_download_request(&payload);
    let remote_path = normalize_remote_path(&payload.remote_path);
    let local_path = payload.local_path.trim();
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    if local_path.is_empty() {
        return Err("请选择本地保存路径。".into());
    }
    validate_remote_path(&remote_path)?;
    let local_path_buf = validate_local_file_path(local_path, "请选择本地保存路径。")?;

    let byte_size = match timeout(
        SSH_FILE_TRANSFER_TIMEOUT,
        task::spawn_blocking({
            let remote_path = remote_path.clone();
            move || download_sftp_file(&params, &remote_path, &local_path_buf)
        }),
    )
    .await
    {
        Ok(Ok(result)) => result?,
        Ok(Err(error)) => return Err(format!("下载远端文件任务失败：{error}")),
        Err(_) => return Err("下载远端文件超时。".into()),
    };

    Ok(SshFileDownloadPayload {
        remote_path,
        local_path: local_path.into(),
        byte_size,
    })
}

#[tauri::command]
pub async fn upload_ssh_file(
    payload: SshFileUploadRequest,
) -> Result<SshFileUploadPayload, String> {
    let params = SshConnectionParams::from_upload_request(&payload);
    let local_path = payload.local_path.trim();
    let remote_directory = normalize_remote_path(&payload.remote_directory);
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    if local_path.is_empty() {
        return Err("请选择要上传的本地文件。".into());
    }
    validate_remote_path(&remote_directory)?;

    let local_file_path = validate_local_file_path(local_path, "请选择要上传的本地文件。")?;
    let file_name = local_file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法识别本地文件名。".to_string())?;
    let metadata = std_fs::metadata(&local_file_path)
        .map_err(|error| format!("读取本地文件信息失败：{error}"))?;
    if !metadata.is_file() {
        return Err("请选择一个本地文件，暂不支持上传目录。".into());
    }

    let remote_path = join_remote_path(&remote_directory, file_name);
    validate_remote_path(&remote_path)?;

    match timeout(
        SSH_FILE_TRANSFER_TIMEOUT,
        task::spawn_blocking({
            let remote_path = remote_path.clone();
            move || upload_sftp_file(&params, &local_file_path, &remote_path)
        }),
    )
    .await
    {
        Ok(Ok(result)) => result?,
        Ok(Err(error)) => return Err(format!("上传本地文件任务失败：{error}")),
        Err(_) => return Err("上传本地文件超时。".into()),
    }

    Ok(SshFileUploadPayload {
        local_path: local_path.into(),
        remote_path,
        byte_size: metadata.len(),
    })
}

#[tauri::command]
pub async fn read_ssh_file(payload: SshFileReadRequest) -> Result<SshFileReadPayload, String> {
    let params = SshConnectionParams::from_read_request(&payload);
    let remote_path = normalize_remote_path(&payload.remote_path);
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    validate_remote_path(&remote_path)?;

    match timeout(
        SSH_FILE_PREVIEW_TIMEOUT,
        task::spawn_blocking({
            let remote_path = remote_path.clone();
            move || read_sftp_text_file(&params, &remote_path)
        }),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("读取远端文件任务失败：{error}")),
        Err(_) => Err("读取远端文件超时。".into()),
    }
}

#[tauri::command]
pub async fn delete_ssh_path(
    payload: SshPathDeleteRequest,
) -> Result<SshPathDeletePayload, String> {
    let params = SshConnectionParams::from_delete_request(&payload);
    let remote_path = normalize_remote_path(&payload.remote_path);
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    if remote_path == "." || remote_path == "/" || remote_path == "~" {
        return Err("拒绝删除远端根目录或当前目录。".into());
    }
    validate_remote_path(&remote_path)?;

    run_sftp_mutation(
        params,
        {
            let remote_path = remote_path.clone();
            move |sftp| delete_sftp_path(sftp, &remote_path)
        },
        "删除远端路径",
    )
    .await?;

    Ok(SshPathDeletePayload { remote_path })
}

#[tauri::command]
pub async fn rename_ssh_path(
    payload: SshPathRenameRequest,
) -> Result<SshPathRenamePayload, String> {
    let params = SshConnectionParams::from_rename_request(&payload);
    let remote_path = normalize_remote_path(&payload.remote_path);
    let new_name = payload.new_name.trim();
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    if !is_safe_file_name(new_name) {
        return Err("新名称不能为空，且不能包含路径分隔符。".into());
    }
    validate_remote_path(&remote_path)?;

    let new_path = join_remote_path(&parent_remote_path(&remote_path), new_name);
    validate_remote_path(&new_path)?;
    run_sftp_mutation(
        params,
        {
            let remote_path = remote_path.clone();
            let new_path = new_path.clone();
            move |sftp| rename_sftp_path(sftp, &remote_path, &new_path)
        },
        "重命名远端路径",
    )
    .await?;

    Ok(SshPathRenamePayload {
        old_path: remote_path,
        new_path,
    })
}

#[tauri::command]
pub async fn create_ssh_directory(
    payload: SshDirectoryCreateRequest,
) -> Result<SshDirectoryCreatePayload, String> {
    let params = SshConnectionParams::from_create_directory_request(&payload);
    let remote_directory = normalize_remote_path(&payload.remote_directory);
    let name = payload.name.trim();
    if params.host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if params.username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(&params.host, &params.username)?;
    if !is_safe_file_name(name) {
        return Err("目录名称不能为空，且不能包含路径分隔符。".into());
    }
    validate_remote_path(&remote_directory)?;

    let remote_path = join_remote_path(&remote_directory, name);
    validate_remote_path(&remote_path)?;
    run_sftp_mutation(
        params,
        {
            let remote_path = remote_path.clone();
            move |sftp| create_sftp_directory(sftp, &remote_path)
        },
        "创建远端目录",
    )
    .await?;

    Ok(SshDirectoryCreatePayload { remote_path })
}

async fn run_sftp_mutation<F>(
    params: SshConnectionParams,
    operation: F,
    action_label: &str,
) -> Result<(), String>
where
    F: FnOnce(&Sftp) -> Result<(), String> + Send + 'static,
{
    let action_label = action_label.to_string();
    match timeout(
        SSH_MUTATION_TIMEOUT,
        task::spawn_blocking(move || {
            let session = open_authenticated_session(&params)?;
            let sftp = session
                .sftp()
                .map_err(|error| format!("打开 SFTP 会话失败：{error}"))?;
            operation(&sftp)
        }),
    )
    .await
    {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("{action_label}任务失败：{error}")),
        Err(_) => Err(format!("{action_label}超时。")),
    }
}

fn open_authenticated_session(params: &SshConnectionParams) -> Result<Session, String> {
    validate_ssh_auth_payload(params)?;
    let address = resolve_ssh_socket_address(&params.host, params.port)?;
    let tcp =
        TcpStream::connect_timeout(&address, Duration::from_secs(SSH_CONNECT_TIMEOUT_SECONDS))
            .map_err(|error| format!("连接 SSH 主机失败：{error}"))?;
    tcp.set_read_timeout(Some(SSH_FILE_TRANSFER_TIMEOUT))
        .map_err(|error| format!("设置 SSH 读取超时失败：{error}"))?;
    tcp.set_write_timeout(Some(SSH_FILE_TRANSFER_TIMEOUT))
        .map_err(|error| format!("设置 SSH 写入超时失败：{error}"))?;

    let mut session = Session::new().map_err(|error| format!("创建 SSH 会话失败：{error}"))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|error| format!("SSH 握手失败：{error}"))?;

    authenticate_session(&session, params)?;
    if !session.authenticated() {
        return Err("SSH 认证失败。".into());
    }

    Ok(session)
}

fn validate_ssh_auth_payload(params: &SshConnectionParams) -> Result<(), String> {
    if params.auth_mode != "key" && params.auth_mode != "password" {
        return Err("不支持的 SSH 认证方式。".into());
    }
    if params.auth_mode == "password"
        && params
            .password
            .as_deref()
            .map(str::is_empty)
            .unwrap_or(true)
    {
        return Err("请填写 SSH 登录密码。".into());
    }

    Ok(())
}

fn resolve_ssh_socket_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("解析 SSH 主机地址失败：{error}"))?
        .next()
        .ok_or_else(|| "解析 SSH 主机地址失败：未找到可用地址。".to_string())
}

fn authenticate_session(session: &Session, params: &SshConnectionParams) -> Result<(), String> {
    if params.auth_mode == "password" {
        let password = params.password.as_deref().unwrap_or_default();
        return session
            .userauth_password(&params.username, password)
            .map_err(|error| format!("SSH 密码认证失败：{error}"));
    }

    if let Some(identity_path) = params.identity_path.as_deref().map(str::trim) {
        if !identity_path.is_empty() {
            session
                .userauth_pubkey_file(
                    &params.username,
                    None,
                    &expand_local_path(identity_path),
                    None,
                )
                .map_err(|error| format!("SSH 密钥认证失败：{error}"))?;
            return Ok(());
        }
    }

    let mut agent = session
        .agent()
        .map_err(|error| format!("连接 SSH agent 失败：{error}"))?;
    agent
        .connect()
        .map_err(|error| format!("连接 SSH agent 失败：{error}"))?;
    agent
        .list_identities()
        .map_err(|error| format!("读取 SSH agent 身份失败：{error}"))?;
    for identity in agent
        .identities()
        .map_err(|error| format!("读取 SSH agent 身份失败：{error}"))?
    {
        if agent.userauth(&params.username, &identity).is_ok() {
            return Ok(());
        }
    }

    Err("SSH agent 中没有可用身份，请选择私钥或输入密码。".into())
}

fn list_sftp_directory(
    params: &SshConnectionParams,
    remote_path: &str,
) -> Result<SshDirectoryListPayload, String> {
    let session = open_authenticated_session(params)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("打开 SFTP 会话失败：{error}"))?;
    let resolved_remote_path = resolve_sftp_realpath(&sftp, remote_path)?;
    let entries = sftp
        .readdir(Path::new(&resolved_remote_path))
        .map_err(|error| format_ssh_directory_error(&error.to_string()))?;
    let mut payload_entries = entries
        .into_iter()
        .filter_map(|(path, stat)| sftp_entry_to_payload(&resolved_remote_path, &path, &stat))
        .collect::<Vec<_>>();
    payload_entries.sort_by(|left, right| {
        (left.kind.as_str() != "directory", left.name.to_lowercase()).cmp(&(
            right.kind.as_str() != "directory",
            right.name.to_lowercase(),
        ))
    });

    Ok(SshDirectoryListPayload {
        path: resolved_remote_path,
        entries: payload_entries,
    })
}

fn resolve_sftp_realpath(sftp: &Sftp, remote_path: &str) -> Result<String, String> {
    let realpath = sftp
        .realpath(Path::new(remote_path))
        .map_err(|error| format!("解析远端真实路径失败：{error}"))?;

    Ok(path_to_remote_string(&realpath))
}

fn path_to_remote_string(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        return "/".into();
    }

    if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    }
}

fn sftp_entry_to_payload(
    directory_path: &str,
    path: &Path,
    stat: &FileStat,
) -> Option<SshDirectoryEntryPayload> {
    let name = path.file_name()?.to_string_lossy().to_string();
    if name == "." || name == ".." {
        return None;
    }
    let kind = if is_directory_stat(stat) {
        "directory"
    } else {
        "file"
    };

    Some(SshDirectoryEntryPayload {
        name: name.clone(),
        path: join_remote_path(directory_path, &name),
        kind: kind.into(),
        size: stat.size.unwrap_or(0),
    })
}

fn download_sftp_file(
    params: &SshConnectionParams,
    remote_path: &str,
    local_path: &Path,
) -> Result<u64, String> {
    let session = open_authenticated_session(params)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("打开 SFTP 会话失败：{error}"))?;
    let stat = sftp
        .stat(Path::new(remote_path))
        .map_err(|error| format_ssh_download_error(&error.to_string()))?;
    if is_directory_stat(&stat) {
        return Err("暂不支持下载目录，请选择一个文件。".into());
    }
    let byte_size = stat.size.unwrap_or(0);

    if let Ok(local_metadata) = std_fs::metadata(local_path) {
        if local_metadata.is_dir() {
            return Err("本地保存路径已存在为目录，无法写入文件。".into());
        }
        if local_metadata.len() == byte_size {
            let _ = std_fs::remove_file(local_partial_path(local_path));
            return Ok(byte_size);
        }
    }

    let partial_path = local_partial_path(local_path);
    let mut resume_offset = match std_fs::metadata(&partial_path) {
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => return Err("本地临时下载路径已存在但不是文件。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("读取本地临时下载文件失败：{error}")),
    };

    if resume_offset > byte_size {
        std_fs::remove_file(&partial_path)
            .map_err(|error| format!("清理过期本地临时下载文件失败：{error}"))?;
        resume_offset = 0;
    }

    if resume_offset == byte_size {
        if partial_path.exists() {
            finalize_local_download(&partial_path, local_path)?;
        } else {
            create_empty_local_download(local_path)?;
        }
        return Ok(byte_size);
    }

    let mut remote_file = sftp
        .open(Path::new(remote_path))
        .map_err(|error| format_ssh_download_error(&error.to_string()))?;
    remote_file
        .seek(SeekFrom::Start(resume_offset))
        .map_err(|error| format!("定位远端下载断点失败：{error}"))?;
    let result = (|| {
        let expected_remaining = byte_size.saturating_sub(resume_offset);
        let mut local_file = std_fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial_path)
            .map_err(|error| format!("打开本地临时下载文件失败：{error}"))?;
        let mut limited_remote_file = (&mut remote_file).take(expected_remaining);
        let copied = copy_stream_with_buffer(
            &mut limited_remote_file,
            &mut local_file,
            "下载远端文件失败",
        )?;
        ensure_expected_transfer_size(copied, expected_remaining, "下载远端文件")?;
        local_file
            .flush()
            .map_err(|error| format!("刷新本地临时文件失败：{error}"))?;
        local_file
            .sync_all()
            .map_err(|error| format!("同步本地临时文件失败：{error}"))?;
        finalize_local_download(&partial_path, local_path)?;
        Ok::<u64, String>(byte_size)
    })();

    result
}

fn upload_sftp_file(
    params: &SshConnectionParams,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), String> {
    let session = open_authenticated_session(params)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("打开 SFTP 会话失败：{error}"))?;
    let local_size = std_fs::metadata(local_path)
        .map_err(|error| format!("读取本地文件信息失败：{error}"))?
        .len();
    let partial_remote_path = remote_partial_path(remote_path);

    if let Ok(remote_stat) = sftp.stat(Path::new(remote_path)) {
        if is_directory_stat(&remote_stat) {
            return Err("远端已存在同名目录，已取消上传。".into());
        }
        if remote_stat.size.unwrap_or(0) == local_size {
            let _ = sftp.unlink(Path::new(&partial_remote_path));
            return Ok(());
        }

        return Err("远端已存在同名文件且大小不一致，已取消上传以避免覆盖。".into());
    }

    let resume_offset = match sftp.stat(Path::new(&partial_remote_path)) {
        Ok(stat) if is_directory_stat(&stat) => {
            return Err("远端临时上传路径已存在为目录，无法续传。".into());
        }
        Ok(stat) => stat.size.unwrap_or(0),
        Err(_) => 0,
    };

    if resume_offset > local_size {
        return Err("远端临时上传文件大于本地文件，已取消上传以避免写坏目标。".into());
    }

    if resume_offset == local_size && local_size > 0 {
        finalize_remote_upload(&sftp, &partial_remote_path, remote_path)?;
        return Ok(());
    }

    let mut local_file =
        std_fs::File::open(local_path).map_err(|error| format!("打开本地文件失败：{error}"))?;
    local_file
        .seek(SeekFrom::Start(resume_offset))
        .map_err(|error| format!("定位本地上传断点失败：{error}"))?;
    let mut remote_file = sftp
        .open_mode(
            Path::new(&partial_remote_path),
            OpenFlags::WRITE | OpenFlags::CREATE,
            0o644,
            OpenType::File,
        )
        .map_err(|error| format_ssh_upload_error(&error.to_string()))?;
    remote_file
        .seek(SeekFrom::Start(resume_offset))
        .map_err(|error| format!("定位远端上传断点失败：{error}"))?;
    let expected_remaining = local_size.saturating_sub(resume_offset);
    let mut limited_local_file = (&mut local_file).take(expected_remaining);
    let copied = copy_stream_with_buffer(
        &mut limited_local_file,
        &mut remote_file,
        "上传本地文件失败",
    )?;
    ensure_expected_transfer_size(copied, expected_remaining, "上传本地文件")?;
    remote_file
        .flush()
        .map_err(|error| format!("刷新远端文件失败：{error}"))?;
    remote_file
        .fsync()
        .map_err(|error| format!("同步远端临时文件失败：{error}"))?;
    drop(remote_file);
    finalize_remote_upload(&sftp, &partial_remote_path, remote_path)?;

    Ok(())
}

fn read_sftp_text_file(
    params: &SshConnectionParams,
    remote_path: &str,
) -> Result<SshFileReadPayload, String> {
    let session = open_authenticated_session(params)?;
    let sftp = session
        .sftp()
        .map_err(|error| format!("打开 SFTP 会话失败：{error}"))?;
    let stat = sftp
        .stat(Path::new(remote_path))
        .map_err(|error| format!("读取远端文件信息失败：{error}"))?;
    if is_directory_stat(&stat) {
        return Err("请选择一个文件查看。".into());
    }
    let byte_size = stat.size.unwrap_or(0);
    if byte_size > SSH_FILE_PREVIEW_MAX_BYTES {
        return Err(format!(
            "远端文件超过 {} MB，请下载到本地查看。",
            SSH_FILE_PREVIEW_MAX_BYTES / 1024 / 1024
        ));
    }

    let mut remote_file = sftp
        .open(Path::new(remote_path))
        .map_err(|error| format!("打开远端文件失败：{error}"))?;
    let mut buffer = Vec::new();
    remote_file
        .read_to_end(&mut buffer)
        .map_err(|error| format!("读取远端文件失败：{error}"))?;
    if buffer.contains(&0) {
        return Err("暂不支持预览二进制文件，请下载到本地查看。".into());
    }
    let content =
        String::from_utf8(buffer).map_err(|_| "远端文件不是有效 UTF-8 文本。".to_string())?;

    Ok(SshFileReadPayload {
        remote_path: remote_path.into(),
        content,
        byte_size,
    })
}

fn delete_sftp_path(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    let stat = sftp
        .stat(Path::new(remote_path))
        .map_err(|error| format!("远端路径不存在或无权访问：{error}"))?;
    if is_directory_stat(&stat) {
        delete_sftp_directory_recursive(sftp, remote_path)?;
        return Ok(());
    }

    sftp.unlink(Path::new(remote_path))
        .map_err(|error| format!("删除远端文件失败：{error}"))
}

fn delete_sftp_directory_recursive(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    let entries = sftp
        .readdir(Path::new(remote_path))
        .map_err(|error| format!("读取待删除目录失败：{error}"))?;
    for (path, stat) in entries {
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }
        let child_path = join_remote_path(remote_path, name);
        if is_directory_stat(&stat) {
            delete_sftp_directory_recursive(sftp, &child_path)?;
        } else {
            sftp.unlink(Path::new(&child_path))
                .map_err(|error| format!("删除远端文件失败：{error}"))?;
        }
    }

    sftp.rmdir(Path::new(remote_path))
        .map_err(|error| format!("删除远端目录失败：{error}"))
}

fn rename_sftp_path(sftp: &Sftp, remote_path: &str, new_path: &str) -> Result<(), String> {
    if sftp.stat(Path::new(new_path)).is_ok() {
        return Err("远端目标已存在，已取消操作以避免覆盖。".into());
    }
    sftp.rename(Path::new(remote_path), Path::new(new_path), None)
        .map_err(|error| format!("重命名远端路径失败：{error}"))
}

fn create_sftp_directory(sftp: &Sftp, remote_path: &str) -> Result<(), String> {
    if sftp.stat(Path::new(remote_path)).is_ok() {
        return Err("远端目标已存在，已取消操作以避免覆盖。".into());
    }
    sftp.mkdir(Path::new(remote_path), 0o755)
        .map_err(|error| format!("创建远端目录失败：{error}"))
}

fn is_directory_stat(stat: &FileStat) -> bool {
    stat.perm
        .map(|perm| perm & S_IFMT == S_IFDIR)
        .unwrap_or(false)
}

fn validate_ssh_endpoint(host: &str, username: &str) -> Result<(), String> {
    if contains_ssh_target_separator(host) {
        return Err("主机地址不能包含空白、换行符或 NUL 字符。".into());
    }
    if contains_ssh_target_separator(username) || username.contains('@') {
        return Err("用户名不能包含空白、换行符、NUL 字符或 @。".into());
    }

    Ok(())
}

fn contains_ssh_target_separator(value: &str) -> bool {
    value
        .chars()
        .any(|ch| ch == '\0' || ch == '\n' || ch == '\r' || ch.is_whitespace())
}

fn failed(code: &str, message: &str) -> SshConnectionTestPayload {
    SshConnectionTestPayload {
        ok: false,
        code: code.into(),
        message: message.into(),
    }
}

fn classify_ssh_error(stderr: &str) -> String {
    let normalized = stderr.to_ascii_lowercase();
    if normalized.contains("permission denied")
        || normalized.contains("publickey")
        || normalized.contains("authentication")
        || normalized.contains("认证失败")
        || normalized.contains("密码认证失败")
        || normalized.contains("密钥认证失败")
    {
        return "ssh/auth-failed".into();
    }
    if normalized.contains("could not resolve hostname")
        || normalized.contains("name or service not known")
        || normalized.contains("nodename nor servname")
        || normalized.contains("解析 ssh 主机地址失败")
    {
        return "ssh/host-unresolved".into();
    }
    if normalized.contains("connection timed out") || normalized.contains("operation timed out") {
        return "ssh/timeout".into();
    }
    if normalized.contains("connection refused") {
        return "ssh/connection-refused".into();
    }
    if normalized.contains("host key verification failed") {
        return "ssh/host-key-untrusted".into();
    }
    "ssh/failed".into()
}

fn format_ssh_error_message(stderr: &str) -> String {
    if stderr.trim().is_empty() {
        return "SSH 连接验证失败。".into();
    }

    format!("SSH 连接验证失败：{}", stderr.trim())
}

fn normalize_remote_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return ".".into();
    }

    trimmed.into()
}

fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.contains('\0') || path.contains('\n') || path.contains('\r') {
        return Err("远端路径不能包含换行符或 NUL 字符。".into());
    }

    Ok(())
}

fn ssh_password_account(host: &str, port: u16, username: &str) -> Result<String, String> {
    let normalized_host = host.trim();
    let normalized_username = username.trim();
    if normalized_host.is_empty() {
        return Err("请填写主机地址。".into());
    }
    if normalized_username.is_empty() {
        return Err("请填写用户名。".into());
    }
    validate_ssh_endpoint(normalized_host, normalized_username)?;

    Ok(format!(
        "password:{normalized_username}@{normalized_host}:{port}"
    ))
}

fn validate_local_file_path(path: &str, empty_message: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(empty_message.into());
    }
    if trimmed.contains('\0') {
        return Err("本地路径不能包含 NUL 字符。".into());
    }

    Ok(PathBuf::from(trimmed))
}

fn copy_stream_with_buffer<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    error_message: &str,
) -> Result<u64, String> {
    let mut buffer = vec![0_u8; SFTP_TRANSFER_CHUNK_BYTES];
    let mut copied = 0_u64;

    loop {
        let bytes_read = reader
            .read(&mut buffer)
            .map_err(|error| format!("{error_message}：{error}"))?;
        if bytes_read == 0 {
            break;
        }

        writer
            .write_all(&buffer[..bytes_read])
            .map_err(|error| format!("{error_message}：{error}"))?;
        copied += bytes_read as u64;
    }

    Ok(copied)
}

fn ensure_expected_transfer_size(copied: u64, expected: u64, action: &str) -> Result<(), String> {
    if copied == expected {
        return Ok(());
    }

    Err(format!(
        "{action}未完整完成，预期剩余 {expected} 字节，实际写入 {copied} 字节。"
    ))
}

fn remote_partial_path(remote_path: &str) -> String {
    format!("{remote_path}{SFTP_PARTIAL_SUFFIX}")
}

fn local_partial_path(local_path: &Path) -> PathBuf {
    let file_name = local_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let partial_file_name = format!("{file_name}{SFTP_PARTIAL_SUFFIX}");

    match local_path.parent() {
        Some(parent) => parent.join(partial_file_name),
        None => PathBuf::from(partial_file_name),
    }
}

fn finalize_local_download(partial_path: &Path, local_path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std_fs::metadata(local_path) {
        if metadata.is_dir() {
            return Err("本地保存路径已存在为目录，无法覆盖。".into());
        }
        std_fs::remove_file(local_path).map_err(|error| format!("覆盖本地文件失败：{error}"))?;
    }

    std_fs::rename(partial_path, local_path).map_err(|error| format!("保存本地文件失败：{error}"))
}

fn create_empty_local_download(local_path: &Path) -> Result<(), String> {
    if let Ok(metadata) = std_fs::metadata(local_path) {
        if metadata.is_dir() {
            return Err("本地保存路径已存在为目录，无法覆盖。".into());
        }
        std_fs::remove_file(local_path).map_err(|error| format!("覆盖本地文件失败：{error}"))?;
    }

    let local_file =
        std_fs::File::create(local_path).map_err(|error| format!("创建本地文件失败：{error}"))?;
    local_file
        .sync_all()
        .map_err(|error| format!("同步本地文件失败：{error}"))
}

fn finalize_remote_upload(
    sftp: &Sftp,
    partial_remote_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    if sftp.stat(Path::new(remote_path)).is_ok() {
        return Err("远端目标文件已存在，已取消提交临时上传文件。".into());
    }

    sftp.rename(
        Path::new(partial_remote_path),
        Path::new(remote_path),
        Some(RenameFlags::ATOMIC | RenameFlags::NATIVE),
    )
    .map_err(|error| format!("提交远端临时上传文件失败：{error}"))
}

#[cfg(test)]
fn quote_posix_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
fn parse_remote_directory_entries(
    stdout: &[u8],
    current_path: &str,
) -> Vec<SshDirectoryEntryPayload> {
    let mut entries = stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .chunks(3)
        .filter_map(|chunk| {
            if chunk.len() != 3 {
                return None;
            }

            let kind = String::from_utf8_lossy(chunk[0]).to_string();
            let size = String::from_utf8_lossy(chunk[1])
                .parse::<u64>()
                .unwrap_or(0);
            let name = String::from_utf8_lossy(chunk[2]).to_string();
            let path = join_remote_path(current_path, &name);
            Some(SshDirectoryEntryPayload {
                name,
                path,
                kind,
                size,
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        (left.kind.as_str() != "directory", left.name.to_lowercase()).cmp(&(
            right.kind.as_str() != "directory",
            right.name.to_lowercase(),
        ))
    });
    entries
}

fn join_remote_path(base: &str, name: &str) -> String {
    let normalized_base = normalize_remote_path(base);
    if normalized_base == "." {
        return name.into();
    }
    if normalized_base == "/" {
        return format!("/{name}");
    }

    format!("{}/{}", normalized_base.trim_end_matches('/'), name)
}

fn parent_remote_path(path: &str) -> String {
    let normalized = normalize_remote_path(path);
    let trimmed = normalized.trim_end_matches('/');
    if trimmed == "." || trimmed == "/" {
        return ".".into();
    }

    match trimmed.rsplit_once('/') {
        Some(("", _)) => "/".into(),
        Some((parent, _)) if !parent.is_empty() => parent.into(),
        _ => ".".into(),
    }
}

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && !name.contains('\n')
        && !name.contains('\r')
}

fn format_ssh_directory_error(stderr: &str) -> String {
    if stderr.trim().is_empty() {
        return "读取远端目录失败。".into();
    }

    format!("读取远端目录失败：{}", stderr.trim())
}

fn format_ssh_download_error(stderr: &str) -> String {
    if stderr.trim().is_empty() {
        return "下载远端文件失败。".into();
    }

    format!("下载远端文件失败：{}", stderr.trim())
}

fn format_ssh_upload_error(stderr: &str) -> String {
    if stderr.trim().is_empty() {
        return "上传本地文件失败。".into();
    }

    format!("上传本地文件失败：{}", stderr.trim())
}

fn expand_local_path(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(trimmed));
    }

    if let Some(stripped) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        if let Some(home) = home_dir() {
            return home.join(stripped);
        }
    }

    PathBuf::from(trimmed)
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn default_ssh_config_path() -> Option<PathBuf> {
    Some(home_dir()?.join(".ssh").join("config"))
}

#[derive(Debug, Default)]
struct SshConfigHostDraft {
    aliases: Vec<String>,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    should_use_config_alias: bool,
}

impl SshConfigHostDraft {
    fn into_payloads(self) -> Vec<SshConfigHostPayload> {
        self.aliases
            .into_iter()
            .filter(|alias| is_concrete_host_alias(alias))
            .map(|alias| {
                let host = if self.should_use_config_alias {
                    alias.clone()
                } else {
                    self.host_name.clone().unwrap_or_else(|| alias.clone())
                };
                let username = self.user.clone().unwrap_or_else(current_username);
                SshConfigHostPayload {
                    id: format!("ssh-config-{alias}"),
                    name: alias,
                    username,
                    host,
                    port: self.port.unwrap_or(DEFAULT_SSH_PORT),
                    identity_path: self.identity_file.clone(),
                    last_used_label: SSH_CONFIG_IMPORTED_LABEL.into(),
                }
            })
            .collect()
    }
}

fn parse_ssh_config_hosts(content: &str) -> Vec<SshConfigHostPayload> {
    let mut hosts = Vec::new();
    let mut current: Option<SshConfigHostDraft> = None;

    for raw_line in content.lines() {
        let Some((keyword, value)) = parse_ssh_config_line(raw_line) else {
            continue;
        };

        if keyword.eq_ignore_ascii_case("Host") {
            if let Some(draft) = current.take() {
                hosts.extend(draft.into_payloads());
            }

            let aliases = value
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>();
            current = Some(SshConfigHostDraft {
                aliases,
                ..SshConfigHostDraft::default()
            });
            continue;
        }

        let Some(draft) = current.as_mut() else {
            continue;
        };

        if keyword.eq_ignore_ascii_case("HostName") {
            draft.host_name = Some(value.to_string());
        } else if keyword.eq_ignore_ascii_case("User") {
            draft.user = Some(value.to_string());
        } else if keyword.eq_ignore_ascii_case("Port") {
            draft.port = value.parse::<u16>().ok();
        } else if keyword.eq_ignore_ascii_case("IdentityFile") {
            draft.identity_file = Some(value.to_string());
        } else if is_ssh_config_resolution_option(keyword) {
            draft.should_use_config_alias = true;
        }
    }

    if let Some(draft) = current {
        hosts.extend(draft.into_payloads());
    }

    hosts
}

fn parse_ssh_config_line(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let without_comment = strip_ssh_config_comment(trimmed).trim();
    if without_comment.is_empty() {
        return None;
    }

    let (keyword, value) = split_ssh_config_keyword(without_comment)?;
    let normalized_value = unquote_ssh_config_value(value.trim());
    if keyword.trim().is_empty() || normalized_value.is_empty() {
        return None;
    }

    Some((keyword.trim(), normalized_value))
}

fn split_ssh_config_keyword(line: &str) -> Option<(&str, &str)> {
    if let Some((keyword, value)) = line.split_once('=') {
        return Some((keyword, value));
    }

    let split_index = line.find(char::is_whitespace)?;
    Some(line.split_at(split_index))
}

fn strip_ssh_config_comment(line: &str) -> &str {
    let mut is_in_quote = false;
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            is_in_quote = !is_in_quote;
            continue;
        }
        if ch == '#' && !is_in_quote {
            return &line[..index];
        }
    }

    line
}

fn unquote_ssh_config_value(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|stripped| stripped.strip_suffix('"'))
        .unwrap_or(value)
}

fn is_ssh_config_resolution_option(keyword: &str) -> bool {
    keyword.eq_ignore_ascii_case("ProxyJump")
        || keyword.eq_ignore_ascii_case("ProxyCommand")
        || keyword.eq_ignore_ascii_case("HostKeyAlias")
        || keyword.eq_ignore_ascii_case("CanonicalizeHostname")
        || keyword.eq_ignore_ascii_case("CanonicalDomains")
        || keyword.eq_ignore_ascii_case("CertificateFile")
        || keyword.eq_ignore_ascii_case("IdentityAgent")
}

fn is_concrete_host_alias(alias: &str) -> bool {
    !alias.is_empty() && !alias.contains('*') && !alias.contains('?') && !alias.starts_with('!')
}

fn current_username() -> String {
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ssh_config_hosts_keeps_direct_host_when_no_advanced_resolution() {
        let content = r#"
Host dev-box
  HostName 192.168.56.10
  User ubuntu
  Port 2202
  IdentityFile "~/.ssh/dev key"
"#;

        let hosts = parse_ssh_config_hosts(content);

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "dev-box");
        assert_eq!(hosts[0].host, "192.168.56.10");
        assert_eq!(hosts[0].username, "ubuntu");
        assert_eq!(hosts[0].port, 2202);
        assert_eq!(hosts[0].identity_path.as_deref(), Some("~/.ssh/dev key"));
    }

    #[test]
    fn parse_ssh_config_hosts_uses_alias_when_proxy_jump_is_required() {
        let content = r#"
Host prod-app
  HostName 10.0.12.31
  User deploy
  ProxyJump bastion
  IdentityFile "~/.ssh/prod # key" # 本地注释不能截断引号内内容
"#;

        let hosts = parse_ssh_config_hosts(content);

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "prod-app");
        assert_eq!(hosts[0].host, "prod-app");
        assert_eq!(hosts[0].username, "deploy");
        assert_eq!(hosts[0].identity_path.as_deref(), Some("~/.ssh/prod # key"));
    }

    #[test]
    fn parse_ssh_config_hosts_filters_wildcard_aliases() {
        let content = r#"
Host * !blocked concrete-host
  User root
"#;

        let hosts = parse_ssh_config_hosts(content);

        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "concrete-host");
    }

    #[test]
    fn parse_remote_directory_entries_keeps_unicode_names_and_directory_first() {
        let stdout = b"file\012\0z.log\0directory\00\0src\0file\03\0\xe4\xbd\xa0\xe5\xa5\xbd.txt\0";

        let entries = parse_remote_directory_entries(stdout, "/home/app");

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].kind, "directory");
        assert_eq!(entries[0].path, "/home/app/src");
        assert_eq!(entries[1].name, "z.log");
        assert_eq!(entries[2].name, "你好.txt");
    }

    #[test]
    fn path_to_remote_string_normalizes_sftp_absolute_path() {
        assert_eq!(path_to_remote_string(Path::new("/home/app")), "/home/app");
        assert_eq!(path_to_remote_string(Path::new(r"\home\app")), "/home/app");
    }

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
    fn ssh_password_account_trims_and_scopes_connection() {
        assert_eq!(
            ssh_password_account(" 192.168.1.10 ", 22, " root ").unwrap(),
            "password:root@192.168.1.10:22"
        );
    }

    #[test]
    fn ssh_password_account_rejects_unsafe_identity() {
        assert!(ssh_password_account("example.com", 22, "root@other").is_err());
        assert!(ssh_password_account("example.com\nbad", 22, "root").is_err());
    }

    #[test]
    fn validate_remote_mutation_names_rejects_path_control_names() {
        assert!(is_safe_file_name("release").then_some(()).is_some());
        assert!(!is_safe_file_name("../release"));
        assert!(!is_safe_file_name("nested/release"));
        assert!(!is_safe_file_name("bad\nname"));
        assert!(validate_remote_path("bad\rpath").is_err());
    }

    #[test]
    fn quote_posix_shell_escapes_single_quotes() {
        assert_eq!(quote_posix_shell("deploy's app"), "'deploy'\\''s app'");
    }
}
