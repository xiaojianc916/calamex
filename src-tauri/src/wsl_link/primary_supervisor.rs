use std::{sync::Arc, time::Duration};

use thiserror::Error;

use super::{
    config::WslLinkTransportConfig,
    grpc_transport::{
        heartbeat_with_grpc_client, open_primary_grpc_connection, WslLinkGrpcConnection,
        WslLinkGrpcHeartbeatAck, WslLinkGrpcTransportError, WslLinkOpenSessionHandshake,
    },
    noise_material::WslLinkDesktopNoiseMaterial,
    protocol::v1::HeartbeatRequest,
    retry::BackoffPolicy,
    types::{now_unix_ms, WslLinkTransportKind},
};

#[derive(Debug, Error)]
pub enum WslLinkPrimarySupervisorError {
    #[error("WSL Link 主通道 gRPC 失败：{0}")]
    Grpc(#[from] WslLinkGrpcTransportError),
}

#[derive(Debug, Clone)]
pub struct WslLinkPrimarySupervisor {
    config: WslLinkTransportConfig,
    client_id: String,
    backoff_policy: BackoffPolicy,
    reconnect_attempt: u32,
    last_client_seq: u64,
    last_ack_server_seq: u64,
}

impl WslLinkPrimarySupervisor {
    pub fn new(client_id: impl Into<String>, config: WslLinkTransportConfig) -> Self {
        Self {
            config,
            client_id: client_id.into(),
            backoff_policy: BackoffPolicy::default(),
            reconnect_attempt: 0,
            last_client_seq: 0,
            last_ack_server_seq: 0,
        }
    }

    pub fn config(&self) -> WslLinkTransportConfig {
        self.config
    }

    pub fn active_transport(&self) -> WslLinkTransportKind {
        self.config.primary_transport()
    }

    pub fn last_client_seq(&self) -> u64 {
        self.last_client_seq
    }

    pub fn last_ack_server_seq(&self) -> u64 {
        self.last_ack_server_seq
    }

    pub fn reconnect_attempt(&self) -> u32 {
        self.reconnect_attempt
    }

    pub fn next_backoff_delay(&self) -> Duration {
        self.backoff_policy
            .delay_for_attempt(self.reconnect_attempt)
    }

    pub fn record_connect_failure(&mut self) -> Duration {
        let delay = self.next_backoff_delay();
        self.reconnect_attempt = self.reconnect_attempt.saturating_add(1);
        delay
    }

    pub fn reset_reconnect_attempts(&mut self) {
        self.reconnect_attempt = 0;
    }

    pub fn build_open_session_handshake(
        &self,
        trace_id: impl Into<String>,
    ) -> Result<WslLinkOpenSessionHandshake, WslLinkGrpcTransportError> {
        WslLinkOpenSessionHandshake::new(self.client_id.clone(), trace_id, self.last_client_seq)
    }

    /// Stage 2 起,Noise 已下沉到传输层 (NoiseStream + perform_initiator_handshake)。
/// 从 supervisor 调用方视角:签名不变,实现细节封装。material 在这里被 wrap 成 Arc,
/// 由 connector 在 Channel 生命周期内复用同一份密钥;一次性 clone (~128B) 优于
/// connector 跨连接 invalidate channel 的代价。
pub async fn open_noise_connection(
    &mut self,
    desktop_material: &WslLinkDesktopNoiseMaterial,
) -> Result<WslLinkGrpcConnection, WslLinkPrimarySupervisorError> {
    let trace_id = format!("wsl-link-reconnect-{}", now_unix_ms());
    let handshake = self.build_open_session_handshake(trace_id)?;
    let connection = open_primary_grpc_connection(
        self.config,
        Arc::new(desktop_material.clone()),
        handshake,
    )
    .await?;
    self.last_ack_server_seq = self.last_ack_server_seq.max(connection.session.server_seq);
    self.last_client_seq = self.last_client_seq.max(connection.session.ack_client_seq);
    self.reset_reconnect_attempts();
    Ok(connection)
}
    pub async fn heartbeat(
        &mut self,
        connection: &mut WslLinkGrpcConnection,
    ) -> Result<WslLinkGrpcHeartbeatAck, WslLinkPrimarySupervisorError> {
        let client_seq = self.allocate_client_seq();
        let ack = heartbeat_with_grpc_client(
            &mut connection.client,
            HeartbeatRequest {
                session_id: connection.session.session_id.clone(),
                client_seq,
                ack_server_seq: self.last_ack_server_seq,
                sent_at_unix_ms: now_unix_ms().min(i64::MAX as u64) as i64,
            },
        )
        .await?;
        self.apply_heartbeat_ack(&ack);
        Ok(ack)
    }

    pub fn allocate_client_seq(&mut self) -> u64 {
        self.last_client_seq = self.last_client_seq.saturating_add(1);
        self.last_client_seq
    }

    pub fn apply_heartbeat_ack(&mut self, ack: &WslLinkGrpcHeartbeatAck) {
        self.last_client_seq = self.last_client_seq.max(ack.ack_client_seq);
        self.last_ack_server_seq = self.last_ack_server_seq.max(ack.server_seq);
    }

    pub fn apply_server_frame_ack(&mut self, server_seq: u64, ack_client_seq: u64) {
        self.last_client_seq = self.last_client_seq.max(ack_client_seq);
        self.last_ack_server_seq = self.last_ack_server_seq.max(server_seq);
    }
}

impl Default for WslLinkPrimarySupervisor {
    fn default() -> Self {
        Self::new("calamex-desktop", WslLinkTransportConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_backoff_advances_and_resets() {
        let mut supervisor = WslLinkPrimarySupervisor::default();
        let first = supervisor.record_connect_failure();
        let second = supervisor.record_connect_failure();

        assert_eq!(supervisor.reconnect_attempt(), 2);
        assert_ne!(first, second);

        supervisor.reset_reconnect_attempts();

        assert_eq!(supervisor.reconnect_attempt(), 0);
    }

    #[test]
    fn supervisor_open_session_uses_last_client_seq() {
        let mut supervisor = WslLinkPrimarySupervisor::default();

        assert_eq!(supervisor.allocate_client_seq(), 1);
        let request = supervisor
            .build_open_session_handshake("trace-1")
            .expect("handshake should build")
            .into_proto();

        assert_eq!(request.last_client_seq, 1);
        assert_eq!(request.client_id, "calamex-desktop");
    }

    #[test]
    fn supervisor_applies_heartbeat_ack() {
        let mut supervisor = WslLinkPrimarySupervisor::default();
        let ack = WslLinkGrpcHeartbeatAck {
            session_id: "s1".to_string(),
            server_seq: 7,
            ack_client_seq: 3,
            received_at_unix_ms: 1,
        };

        supervisor.apply_heartbeat_ack(&ack);

        assert_eq!(supervisor.last_ack_server_seq(), 7);
        assert_eq!(supervisor.last_client_seq(), 3);
        assert_eq!(
            supervisor.active_transport(),
            WslLinkTransportKind::VsockGrpc
        );
    }
}
