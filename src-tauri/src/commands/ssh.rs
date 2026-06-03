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
//! 持有 `#[tauri::command] + #[specta::specta]` 命令的子模块（connection/credentials/
//! config/transfer）声明为 `pub(crate)`，由 `tauri_bindings.rs` 用模块限定路径
//! （如 `ssh::transfer::read_ssh_file`）直接登记并解析 tauri-specta 配套宏；
//! 因此不再在此重新导出扁平命令名。

use super::{
    SshConnectionTestRequest, SshDirectoryCreateRequest, SshDirectoryListRequest,
    SshFileDownloadRequest, SshFileReadRequest, SshFileUploadRequest, SshFileWriteRequest,
    SshPathDeleteRequest, SshPathRenameRequest,
};

pub(crate) mod config;
pub(crate) mod connection;
pub(crate) mod credentials;
mod hostkey;
pub(crate) mod transfer;
mod util;

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
        // 用 volatile 写 + 编译屏障逐字节覆盖密码，避免编译器把「写后即弃」的
        // 清零作为死存储优化掉；涉及堆上明文密码的安全擦除。
        if let Some(p) = self.password.as_mut() {
            // SAFETY: 仅将已分配的 UTF-8 缓冲区逐字节覆写为 0，不改变长度 / 容量；
            // 全 0 始终是合法 UTF-8，且 clear() 前缓冲区内容已不再被使用。
            unsafe {
                for b in p.as_bytes_mut() {
                    std::ptr::write_volatile(b, 0u8);
                }
            }
            std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
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
