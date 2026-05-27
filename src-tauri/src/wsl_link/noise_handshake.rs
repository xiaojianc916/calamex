// src-tauri/src/wsl_link/noise_handshake.rs
//! 网络版 Noise KKpsk2 握手 helper。
//!
//! 在已有 AsyncRead + AsyncWrite 流上，按 length-prefixed 帧（2-byte big-endian u16）
//! 交换 KKpsk2 的两条握手消息，最后把 HandshakeState 转入 TransportState，
//! 返回 (流, transport) 给上层包装成 NoiseStream。
//!
//! KKpsk2 流程（payload 均为空）：
//!   msg1: initiator -> responder  (e, es, ss)
//!   msg2: responder -> initiator  (e, ee, se, psk)

use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::noise::{
    build_initiator, build_responder, into_transport_mode, read_empty_handshake_message,
    write_empty_handshake_message, WslLinkNoiseError, WslLinkNoiseHandshakeConfig,
    WslLinkNoiseTransport, WSL_LINK_NOISE_MAX_MESSAGE_BYTES,
};

#[derive(Debug, Error)]
pub enum WslLinkNoiseHandshakeError {
    #[error("WSL Link Noise 握手 IO 失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("WSL Link Noise 握手协议失败：{0}")]
    Noise(#[from] WslLinkNoiseError),
    #[error("WSL Link Noise 握手帧长度越界：{actual} > {max}")]
    FrameTooLarge { actual: usize, max: usize },
}

async fn write_handshake_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    payload: &[u8],
) -> Result<(), WslLinkNoiseHandshakeError> {
    if payload.len() > WSL_LINK_NOISE_MAX_MESSAGE_BYTES {
        return Err(WslLinkNoiseHandshakeError::FrameTooLarge {
            actual: payload.len(),
            max: WSL_LINK_NOISE_MAX_MESSAGE_BYTES,
        });
    }
    // 上面保证 fit 进 u16
    let len = payload.len() as u16;
    stream.write_all(&len.to_be_bytes()).await?;
    stream.write_all(payload).await?;
    Ok(())
}

async fn read_handshake_frame<S: AsyncRead + Unpin>(
    stream: &mut S,
) -> Result<Vec<u8>, WslLinkNoiseHandshakeError> {
    let mut len_buf = [0_u8; 2];
    stream.read_exact(&mut len_buf).await?;
    let len = u16::from_be_bytes(len_buf) as usize;
    if len > WSL_LINK_NOISE_MAX_MESSAGE_BYTES {
        return Err(WslLinkNoiseHandshakeError::FrameTooLarge {
            actual: len,
            max: WSL_LINK_NOISE_MAX_MESSAGE_BYTES,
        });
    }
    let mut buf = vec![0_u8; len];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// Initiator (desktop) 侧：发起握手。
///
/// 1. 发 msg1
/// 2. 收 msg2
/// 3. into_transport_mode
pub async fn perform_initiator_handshake<S>(
    mut stream: S,
    config: &WslLinkNoiseHandshakeConfig,
) -> Result<(S, WslLinkNoiseTransport), WslLinkNoiseHandshakeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut state = build_initiator(config)?;
    let msg1 = write_empty_handshake_message(&mut state)?;
    write_handshake_frame(&mut stream, &msg1).await?;
    stream.flush().await?;
    let msg2 = read_handshake_frame(&mut stream).await?;
    read_empty_handshake_message(&mut state, &msg2)?;
    let transport = into_transport_mode(state)?;
    Ok((stream, transport))
}

/// Responder (agent) 侧：接受握手。
///
/// 1. 收 msg1
/// 2. 发 msg2
/// 3. into_transport_mode
pub async fn perform_responder_handshake<S>(
    mut stream: S,
    config: &WslLinkNoiseHandshakeConfig,
) -> Result<(S, WslLinkNoiseTransport), WslLinkNoiseHandshakeError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut state = build_responder(config)?;
    let msg1 = read_handshake_frame(&mut stream).await?;
    read_empty_handshake_message(&mut state, &msg1)?;
    let msg2 = write_empty_handshake_message(&mut state)?;
    write_handshake_frame(&mut stream, &msg2).await?;
    stream.flush().await?;
    let transport = into_transport_mode(state)?;
    Ok((stream, transport))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wsl_link::noise::{
        generate_static_keypair, WslLinkNoisePsk, WSL_LINK_NOISE_KEY_BYTES,
    };
    use tokio::io::duplex;

    fn make_configs() -> (WslLinkNoiseHandshakeConfig, WslLinkNoiseHandshakeConfig) {
        let psk = WslLinkNoisePsk::from_bytes([0x42; WSL_LINK_NOISE_KEY_BYTES]);
        let desktop = generate_static_keypair().expect("desktop keypair");
        let agent = generate_static_keypair().expect("agent keypair");
        let initiator = WslLinkNoiseHandshakeConfig::new(
            *desktop.private(),
            *agent.public(),
            psk.clone(),
        );
        let responder =
            WslLinkNoiseHandshakeConfig::new(*agent.private(), *desktop.public(), psk);
        (initiator, responder)
    }

    #[tokio::test]
    async fn over_duplex_completes_and_transports_round_trip() {
        let (client, server) = duplex(64 * 1024);
        let (initiator_cfg, responder_cfg) = make_configs();

        let client_handle = tokio::spawn(async move {
            perform_initiator_handshake(client, &initiator_cfg).await
        });
        let server_handle = tokio::spawn(async move {
            perform_responder_handshake(server, &responder_cfg).await
        });

        let (_client, mut initiator_transport) =
            client_handle.await.expect("join").expect("initiator handshake");
        let (_server, mut responder_transport) =
            server_handle.await.expect("join").expect("responder handshake");

        let ct = initiator_transport.encrypt_frame(b"ping").expect("encrypt");
        let pt = responder_transport.decrypt_frame(&ct).expect("decrypt");
        assert_eq!(pt, b"ping");

        let ct = responder_transport.encrypt_frame(b"pong").expect("encrypt");
        let pt = initiator_transport.decrypt_frame(&ct).expect("decrypt");
        assert_eq!(pt, b"pong");
    }

    #[tokio::test]
    async fn mismatched_psk_fails_handshake() {
        let (client, server) = duplex(64 * 1024);
        let desktop = generate_static_keypair().expect("desktop");
        let agent = generate_static_keypair().expect("agent");
        let initiator_cfg = WslLinkNoiseHandshakeConfig::new(
            *desktop.private(),
            *agent.public(),
            WslLinkNoisePsk::from_bytes([0x01; WSL_LINK_NOISE_KEY_BYTES]),
        );
        let responder_cfg = WslLinkNoiseHandshakeConfig::new(
            *agent.private(),
            *desktop.public(),
            WslLinkNoisePsk::from_bytes([0x02; WSL_LINK_NOISE_KEY_BYTES]),
        );

        let client_handle = tokio::spawn(async move {
            perform_initiator_handshake(client, &initiator_cfg).await
        });
        let server_handle = tokio::spawn(async move {
            perform_responder_handshake(server, &responder_cfg).await
        });

        let client_result = client_handle.await.expect("join");
        let server_result = server_handle.await.expect("join");
        // 至少一侧应失败（responder 解 msg1 必失败，initiator 可能 EOF）
        assert!(client_result.is_err() || server_result.is_err());
    }
}