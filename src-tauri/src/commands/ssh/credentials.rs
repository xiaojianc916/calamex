//! 基于系统钥匙串（keyring）的 SSH 密码存取命令。

use crate::commands::{
    SshPasswordGetRequest, SshPasswordPayload, SshPasswordSaveRequest, SshPasswordStatusPayload,
};

const SSH_KEYRING_SERVICE: &str = "calamex.ssh";

fn scrub_secret_string(value: &mut String) {
    unsafe {
        for b in value.as_bytes_mut() {
            std::ptr::write_volatile(b, 0u8);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    value.clear();
}
#[tauri::command]
#[specta::specta]
pub async fn save_ssh_password(
    payload: SshPasswordSaveRequest,
) -> Result<SshPasswordStatusPayload, String> {
    let account = ssh_password_account(&payload.host, payload.port, &payload.username)?;
    let mut password = payload.password.expose().to_string();
    tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SSH_KEYRING_SERVICE, &account)
            .map_err(|e| format!("无法创建凭据条目：{e}"))?;
        let result = entry
            .set_password(&password)
            .map_err(|e| format!("无法保存 SSH 密码：{e}"));
        scrub_secret_string(&mut password);
        result?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("保存密码任务异常终止：{e}"))??;
    Ok(SshPasswordStatusPayload { has_password: true })
}

#[tauri::command]
#[specta::specta]
pub async fn get_ssh_password(
    payload: SshPasswordGetRequest,
) -> Result<SshPasswordPayload, String> {
    let account = ssh_password_account(&payload.host, payload.port, &payload.username)?;
    let password = tokio::task::spawn_blocking(move || {
        let entry = keyring::Entry::new(SSH_KEYRING_SERVICE, &account)
            .map_err(|e| format!("无法创建凭据条目：{e}"))?;
        match entry.get_password() {
            Ok(password) => Ok(password),
            Err(keyring::Error::NoEntry) => Err("未找到该连接的已保存密码。".to_string()),
            Err(e) => Err(format!("无法读取 SSH 密码：{e}")),
        }
    })
    .await
    .map_err(|e| format!("读取密码任务异常终止：{e}"))??;
    Ok(SshPasswordPayload { password })
}

fn ssh_password_account(host: &str, port: u16, username: &str) -> Result<String, String> {
    let host = host.trim();
    let username = username.trim();
    if host.is_empty() || username.is_empty() {
        return Err("主机地址或用户名不能为空。".into());
    }
    if host.contains('\n')
        || host.contains('\r')
        || username.contains('\n')
        || username.contains('\r')
        || username.contains('@')
    {
        return Err("主机地址或用户名包含不允许的字符。".into());
    }
    Ok(format!("password:{username}@{host}:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(ssh_password_account("", 22, "root").is_err());
    }
}
