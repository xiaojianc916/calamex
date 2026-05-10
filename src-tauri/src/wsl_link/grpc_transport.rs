use thiserror::Error;
use tonic::transport::Channel;

use super::{
    config::WslLinkTransportConfig,
    noise::{
        build_initiator, into_transport_mode, read_empty_handshake_message,
        write_empty_handshake_message, WslLinkNoiseError,
    },
    noise_material::{WslLinkDesktopNoiseMaterial, WslLinkNoiseMaterialError},
    protocol::v1::{
        wsl_link_client::WslLinkClient, HeartbeatRequest, HeartbeatResponse,
        OpenNoiseSessionRequest, OpenSessionRequest, OpenSessionResponse, TransportKind,
    },
    types::{noise_server_proof_payload, WslLinkTransportKind, DEFAULT_PROTOCOL_VERSION},
};

pub type WslLinkGrpcClient = WslLinkClient<Channel>;

#[derive(Debug, Error)]
pub enum WslLinkGrpcTransportError {
    #[error("WSL Link OpenSession 请求无效：{0}")]
    InvalidOpenSessionRequest(&'static str),
    #[error("WSL Link OpenSession 响应无效：{0}")]
    InvalidOpenSessionResponse(&'static str),
    #[error("WSL Link gRPC 主通道暂不支持当前平台：{0:?}")]
    UnsupportedPlatform(WslLinkTransportKind),
    #[error("WSL Link gRPC 主通道建立失败：{0}")]
    Transport(#[from] tonic::transport::Error),
    #[error("WSL Link gRPC 主通道连接器失败：{0}")]
    Connector(String),
    #[error("WSL Link OpenSession RPC 失败：{0}")]
    Status(#[from] tonic::Status),
    #[error("WSL Link Noise 密钥材料不可用：{0}")]
    NoiseMaterial(#[from] WslLinkNoiseMaterialError),
    #[error("WSL Link Noise 握手失败：{0}")]
    Noise(#[from] WslLinkNoiseError),
    #[error("WSL Link Noise server proof 不匹配。")]
    InvalidNoiseServerProof,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkOpenSessionHandshake {
    client_id: String,
    trace_id: String,
    last_client_seq: u64,
}

impl WslLinkOpenSessionHandshake {
    pub fn new(
        client_id: impl Into<String>,
        trace_id: impl Into<String>,
        last_client_seq: u64,
    ) -> Result<Self, WslLinkGrpcTransportError> {
        let client_id = client_id.into();
        if client_id.trim().is_empty() {
            return Err(WslLinkGrpcTransportError::InvalidOpenSessionRequest(
                "client_id 不能为空。",
            ));
        }

        let trace_id = trace_id.into();
        if trace_id.trim().is_empty() {
            return Err(WslLinkGrpcTransportError::InvalidOpenSessionRequest(
                "trace_id 不能为空。",
            ));
        }

        Ok(Self {
            client_id,
            trace_id,
            last_client_seq,
        })
    }

    pub fn into_proto(self) -> OpenSessionRequest {
        OpenSessionRequest {
            client_id: self.client_id,
            protocol_version: DEFAULT_PROTOCOL_VERSION.to_string(),
            last_client_seq: self.last_client_seq,
            trace_id: self.trace_id,
        }
    }

    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkGrpcSession {
    pub session_id: String,
    pub server_seq: u64,
    pub ack_client_seq: u64,
    pub transport: WslLinkTransportKind,
}

impl WslLinkGrpcSession {
    pub fn try_from_open_session_response(
        response: OpenSessionResponse,
    ) -> Result<Self, WslLinkGrpcTransportError> {
        if response.session_id.trim().is_empty() {
            return Err(WslLinkGrpcTransportError::InvalidOpenSessionResponse(
                "session_id 不能为空。",
            ));
        }
        if response.server_seq == 0 {
            return Err(WslLinkGrpcTransportError::InvalidOpenSessionResponse(
                "server_seq 必须大于 0。",
            ));
        }

        let transport = match TransportKind::try_from(response.transport)
            .unwrap_or(TransportKind::Unspecified)
        {
            TransportKind::VsockGrpc => WslLinkTransportKind::VsockGrpc,
            TransportKind::Unspecified => {
                return Err(WslLinkGrpcTransportError::InvalidOpenSessionResponse(
                    "transport 必须是 VSOCK gRPC。",
                ));
            }
        };

        Ok(Self {
            session_id: response.session_id,
            server_seq: response.server_seq,
            ack_client_seq: response.ack_client_seq,
            transport,
        })
    }
}

#[derive(Debug)]
pub struct WslLinkGrpcConnection {
    pub client: WslLinkGrpcClient,
    pub session: WslLinkGrpcSession,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkGrpcHeartbeatAck {
    pub session_id: String,
    pub server_seq: u64,
    pub ack_client_seq: u64,
    pub received_at_unix_ms: i64,
}

impl WslLinkGrpcHeartbeatAck {
    pub fn try_from_response(
        response: HeartbeatResponse,
    ) -> Result<Self, WslLinkGrpcTransportError> {
        if response.session_id.trim().is_empty() {
            return Err(WslLinkGrpcTransportError::InvalidOpenSessionResponse(
                "heartbeat session_id 不能为空。",
            ));
        }
        if response.server_seq == 0 {
            return Err(WslLinkGrpcTransportError::InvalidOpenSessionResponse(
                "heartbeat server_seq 必须大于 0。",
            ));
        }

        Ok(Self {
            session_id: response.session_id,
            server_seq: response.server_seq,
            ack_client_seq: response.ack_client_seq,
            received_at_unix_ms: response.received_at_unix_ms,
        })
    }
}

pub async fn connect_primary_grpc_channel(
    config: WslLinkTransportConfig,
) -> Result<Channel, WslLinkGrpcTransportError> {
    platform_connect_primary_grpc_channel(config).await
}

pub async fn connect_primary_grpc_client(
    config: WslLinkTransportConfig,
) -> Result<WslLinkGrpcClient, WslLinkGrpcTransportError> {
    let channel = connect_primary_grpc_channel(config).await?;
    Ok(WslLinkGrpcClient::new(channel))
}

pub async fn open_primary_grpc_session(
    config: WslLinkTransportConfig,
    handshake: WslLinkOpenSessionHandshake,
) -> Result<WslLinkGrpcSession, WslLinkGrpcTransportError> {
    let mut client = connect_primary_grpc_client(config).await?;
    open_session_with_grpc_client(&mut client, handshake).await
}

pub async fn open_primary_noise_session(
    config: WslLinkTransportConfig,
    handshake: WslLinkOpenSessionHandshake,
    desktop_material: &WslLinkDesktopNoiseMaterial,
) -> Result<WslLinkGrpcSession, WslLinkGrpcTransportError> {
    let mut client = connect_primary_grpc_client(config).await?;
    open_noise_session_with_grpc_client(&mut client, handshake, desktop_material).await
}

pub async fn open_primary_noise_connection(
    config: WslLinkTransportConfig,
    handshake: WslLinkOpenSessionHandshake,
    desktop_material: &WslLinkDesktopNoiseMaterial,
) -> Result<WslLinkGrpcConnection, WslLinkGrpcTransportError> {
    let mut client = connect_primary_grpc_client(config).await?;
    let session =
        open_noise_session_with_grpc_client(&mut client, handshake, desktop_material).await?;
    Ok(WslLinkGrpcConnection { client, session })
}

pub async fn open_session_with_grpc_client(
    client: &mut WslLinkGrpcClient,
    handshake: WslLinkOpenSessionHandshake,
) -> Result<WslLinkGrpcSession, WslLinkGrpcTransportError> {
    let response = client
        .open_session(handshake.into_proto())
        .await?
        .into_inner();
    WslLinkGrpcSession::try_from_open_session_response(response)
}

pub async fn open_noise_session_with_grpc_client(
    client: &mut WslLinkGrpcClient,
    handshake: WslLinkOpenSessionHandshake,
    desktop_material: &WslLinkDesktopNoiseMaterial,
) -> Result<WslLinkGrpcSession, WslLinkGrpcTransportError> {
    let trace_id = handshake.trace_id().to_string();
    let mut initiator = build_initiator(&desktop_material.initiator_config())?;
    let handshake_message = write_empty_handshake_message(&mut initiator)?;
    let response = client
        .open_noise_session(OpenNoiseSessionRequest {
            open_session: Some(handshake.into_proto()),
            handshake_message,
        })
        .await?
        .into_inner();

    read_empty_handshake_message(&mut initiator, &response.handshake_message)?;
    let mut transport = into_transport_mode(initiator)?;
    let open_session =
        response
            .open_session
            .ok_or(WslLinkGrpcTransportError::InvalidOpenSessionResponse(
                "open_session 不能为空。",
            ))?;
    let proof = transport.decrypt_frame(&response.encrypted_server_proof)?;
    let expected = noise_server_proof_payload(&trace_id, &open_session.session_id);
    if proof != expected {
        return Err(WslLinkGrpcTransportError::InvalidNoiseServerProof);
    }

    WslLinkGrpcSession::try_from_open_session_response(open_session)
}

pub async fn heartbeat_with_grpc_client(
    client: &mut WslLinkGrpcClient,
    request: HeartbeatRequest,
) -> Result<WslLinkGrpcHeartbeatAck, WslLinkGrpcTransportError> {
    let response = client.heartbeat(request).await?.into_inner();
    WslLinkGrpcHeartbeatAck::try_from_response(response)
}

#[cfg(windows)]
async fn platform_connect_primary_grpc_channel(
    config: WslLinkTransportConfig,
) -> Result<Channel, WslLinkGrpcTransportError> {
    let endpoint = config.grpc_client_endpoint()?;
    let connector_error = windows::new_connector_error_slot();
    let connector = windows::WslLinkHypervGrpcConnector::new(
        config.vsock_grpc_port,
        config.connect_timeout,
        connector_error.clone(),
    );
    endpoint
        .connect_with_connector(connector)
        .await
        .map_err(|error| {
            windows::take_connector_error(&connector_error)
                .map(WslLinkGrpcTransportError::Connector)
                .unwrap_or_else(|| WslLinkGrpcTransportError::Transport(error))
        })
}

#[cfg(not(windows))]
async fn platform_connect_primary_grpc_channel(
    config: WslLinkTransportConfig,
) -> Result<Channel, WslLinkGrpcTransportError> {
    Err(WslLinkGrpcTransportError::UnsupportedPlatform(
        config.primary_transport(),
    ))
}

#[cfg(windows)]
mod windows {
    use std::{
        future::Future,
        pin::Pin,
        sync::{Arc, Mutex},
        task::{Context, Poll},
        time::Duration,
    };

    use hyper_util::rt::TokioIo;
    use tonic::{codegen::Service, transport::Uri};

    use crate::wsl_link::adapters::windows_hyperv::{
        connect_wsl_vsock_grpc_stream, WslLinkHypervConnectError,
    };

    pub(super) type ConnectorErrorSlot = Arc<Mutex<Option<String>>>;

    pub(super) fn new_connector_error_slot() -> ConnectorErrorSlot {
        Arc::new(Mutex::new(None))
    }

    pub(super) fn record_connector_error(slot: &ConnectorErrorSlot, error: String) {
        if let Ok(mut last_error) = slot.lock() {
            *last_error = Some(error);
        }
    }

    pub(super) fn take_connector_error(slot: &ConnectorErrorSlot) -> Option<String> {
        slot.lock()
            .ok()
            .and_then(|mut last_error| last_error.take())
    }

    #[derive(Debug, Clone)]
    pub struct WslLinkHypervGrpcConnector {
        vsock_grpc_port: u32,
        connect_timeout: Duration,
        last_error: ConnectorErrorSlot,
    }

    impl WslLinkHypervGrpcConnector {
        pub fn new(
            vsock_grpc_port: u32,
            connect_timeout: Duration,
            last_error: ConnectorErrorSlot,
        ) -> Self {
            Self {
                vsock_grpc_port,
                connect_timeout,
                last_error,
            }
        }

        pub fn connect_timeout(&self) -> Duration {
            self.connect_timeout
        }

        pub fn vsock_grpc_port(&self) -> u32 {
            self.vsock_grpc_port
        }
    }

    impl Service<Uri> for WslLinkHypervGrpcConnector {
        type Response = TokioIo<tokio::net::TcpStream>;
        type Error = WslLinkHypervConnectError;
        type Future =
            Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send + 'static>>;

        fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, _request: Uri) -> Self::Future {
            let timeout = self.connect_timeout;
            let vsock_grpc_port = self.vsock_grpc_port;
            let last_error = self.last_error.clone();
            Box::pin(async move {
                match connect_wsl_vsock_grpc_stream(vsock_grpc_port, timeout).await {
                    Ok(stream) => Ok(TokioIo::new(stream)),
                    Err(error) => {
                        record_connector_error(&last_error, error.to_string());
                        Err(error)
                    }
                }
            })
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    use super::*;

    use crate::wsl_link::protocol::v1::TransportKind;

    #[test]
    fn open_session_handshake_rejects_empty_client_id() {
        let result = super::WslLinkOpenSessionHandshake::new("  ", "trace-1", 0);

        assert!(matches!(
            result,
            Err(super::WslLinkGrpcTransportError::InvalidOpenSessionRequest(
                _
            ))
        ));
    }

    #[test]
    fn open_session_handshake_builds_versioned_proto_request() {
        let request = super::WslLinkOpenSessionHandshake::new("desktop-1", "trace-1", 7)
            .expect("handshake should be valid")
            .into_proto();

        assert_eq!(request.client_id, "desktop-1");
        assert_eq!(
            request.protocol_version,
            crate::wsl_link::types::DEFAULT_PROTOCOL_VERSION
        );
        assert_eq!(request.last_client_seq, 7);
        assert_eq!(request.trace_id, "trace-1");
    }

    #[test]
    fn open_session_response_maps_transport_kind() {
        let session = super::WslLinkGrpcSession::try_from_open_session_response(
            crate::wsl_link::protocol::v1::OpenSessionResponse {
                session_id: "s1".to_string(),
                server_seq: 1,
                ack_client_seq: 7,
                transport: TransportKind::VsockGrpc as i32,
            },
        )
        .expect("response should map");

        assert_eq!(session.session_id, "s1");
        assert_eq!(session.server_seq, 1);
        assert_eq!(session.ack_client_seq, 7);
        assert_eq!(
            session.transport,
            crate::wsl_link::types::WslLinkTransportKind::VsockGrpc
        );
    }

    #[test]
    fn open_session_response_rejects_unspecified_transport() {
        let result = super::WslLinkGrpcSession::try_from_open_session_response(
            crate::wsl_link::protocol::v1::OpenSessionResponse {
                session_id: "s1".to_string(),
                server_seq: 1,
                ack_client_seq: 0,
                transport: TransportKind::Unspecified as i32,
            },
        );

        assert!(matches!(
            result,
            Err(super::WslLinkGrpcTransportError::InvalidOpenSessionResponse(_))
        ));
    }

    #[test]
    fn heartbeat_response_rejects_empty_session_id() {
        let result = super::WslLinkGrpcHeartbeatAck::try_from_response(
            crate::wsl_link::protocol::v1::HeartbeatResponse {
                session_id: String::new(),
                server_seq: 1,
                ack_client_seq: 1,
                received_at_unix_ms: 1,
            },
        );

        assert!(matches!(
            result,
            Err(super::WslLinkGrpcTransportError::InvalidOpenSessionResponse(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_connector_keeps_configured_timeout() {
        let connector = super::windows::WslLinkHypervGrpcConnector::new(
            crate::wsl_link::types::DEFAULT_VSOCK_GRPC_PORT,
            std::time::Duration::from_millis(123),
            super::windows::new_connector_error_slot(),
        );

        assert_eq!(
            connector.connect_timeout(),
            std::time::Duration::from_millis(123)
        );
        assert_eq!(
            connector.vsock_grpc_port(),
            crate::wsl_link::types::DEFAULT_VSOCK_GRPC_PORT
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_connector_error_slot_is_consumed_once() {
        let slot = super::windows::new_connector_error_slot();

        super::windows::record_connector_error(&slot, "WSL Link 连接失败".to_string());

        assert_eq!(
            super::windows::take_connector_error(&slot),
            Some("WSL Link 连接失败".to_string())
        );
        assert_eq!(super::windows::take_connector_error(&slot), None);
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn primary_grpc_channel_reports_unsupported_platform() {
        let result = connect_primary_grpc_channel(WslLinkTransportConfig::default()).await;

        assert!(matches!(
            result,
            Err(WslLinkGrpcTransportError::UnsupportedPlatform(
                WslLinkTransportKind::VsockGrpc
            ))
        ));
    }
}
