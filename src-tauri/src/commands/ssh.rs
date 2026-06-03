//! SSH/SFTP 命令模块入口。
//!
//! 历史上所有 SSH 相关实现集中在单个 `ssh.rs`（约 1.8k 行）。为满足文件体量
//! 治理（R-20.x）并保持结构清晰，这里仅保留跨子模块共享的连接参数类型与端口
//! 常量，具体实现拆分到 `ssh/` 子模块：
//!
//! - `connection`：建链 / 认证 / SFTP 会话 / 连接性测试 / 主机密钥信任命令
//! - `hostkey`：known_hosts 校验与变更处理
//! - `transfer`：目录与文件读写、上传下载等 SFTP 操作命令
//! - `util`：远程路径、文本编解码、权限位渲染等纯函数工具
//! - `credentials`：基于系统钥匙串的密码存取命令
//! - `config`：解析 ~/.ssh/config 主机列表命令
//!
//! 对外命令名经由下方 `pub use` 重新导出，`commands/mod.rs` 的注册路径保持不变。

use super::{
    SshConnectionTestRequest, SshDirectoryCreateRequest, SshDirectoryListRequest,
    SshFileDownloadRequest, SshFileReadRequest, SshFileUploadRequest, SshFileWriteRequest,
    SshPathDeleteRequest, SshPathRenameRequest,
};

mod config;
mod connection;
mod credentials;
mod hostkey;
mod transfer;
mod util;

pub use config::list_ssh_config_hosts;
pub use connection::{test_ssh_connection, trust_ssh_host_key, SshHostKeyTrustPayload};
pub use credentials::{get_ssh_password, save_ssh_password};
pub use transfer::{
    create_ssh_directory, delete_ssh_path, download_ssh_file, list_ssh_directory, read_ssh_file,
    rename_ssh_path, upload_ssh_file, write_ssh_file,
};

// `ssh_pool` 通过 `super::ssh::{connect_and_auth, SshClientHandler}` 引用这两项。
pub(crate) use connection::{connect_and_auth, SshClientHandler};

/// 默认 SSH 端口；被 `hostkey` 与 `config` 子模块通过 `super::DEFAULT_SSH_PORT` 引用。
const DEFAULT_SSH_PORT: u16 = 22;

// ---- connection parameters ----
#[derive(Debug, Clone)]
pub(crate) struct SshConnectionParams {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<String>,
}

impl Drop for SshConnectionParams {
    fn drop(&mut self) {
        if let Some(p) = self.password.as_mut() {
            unsafe {
                for b in p.as_bytes_mut() {
                    *b = 0;
                }
            }
            p.clear();
        }
    }
}

macro_rules! impl_ssh_connection_params_from_request {
    ($($method:ident => $request:ty),* $(,)?) => {
        impl SshConnectionParams {
            $(
                pub(crate) fn $method(payload: &$request) -> Self {
                    Self {
                        host: payload.host.trim().into(),
                        port: payload.port,
                        username: payload.username.trim().into(),
                        auth_mode: payload.auth_mode.clone(),
                        identity_path: payload.identity_path.clone(),
                        // `password` is a redacted `SecretString` on the wire; take a
                        // plain copy here only for the connection itself. This copy
                        // is scrubbed by `SshConnectionParams::Drop`.
                        password: payload.password.as_ref().map(|p| p.expose().to_string()),
                    }
                }
            )*
        }
    };
}

impl_ssh_connection_params_from_request! {
    from_test_request             => SshConnectionTestRequest,
    from_directory_request        => SshDirectoryListRequest,
    from_download_request         => SshFileDownloadRequest,
    from_upload_request           => SshFileUploadRequest,
    from_delete_request           => SshPathDeleteRequest,
    from_rename_request           => SshPathRenameRequest,
    from_create_directory_request => SshDirectoryCreateRequest,
    from_read_request             => SshFileReadRequest,
    from_write_request            => SshFileWriteRequest,
}
