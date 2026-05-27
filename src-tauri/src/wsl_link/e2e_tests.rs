//! Stage 3-A: 桌面 ↔ Agent 进程内 end-to-end 集成测试。
//!
//! 在同一进程内通过 `tokio::io::duplex` 模拟 vsock 双向管道,
//! 同时运行 `WslLinkAgentService` + tonic server (responder 握手)
//! 与 tonic client (initiator 握手),验证完整的:
//!   bytes → Noise 加密 → duplex → Noise 解密 → tonic gRPC → service 处理
//! 端到端链路,无需真实 WSL2 / Hyper-V vsock / 凭据容器。

#![cfg(test)]

use std::{
    convert::Infallible,
    io,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use pin_project_lite::pin_project;
use tokio::{
    io::{duplex, AsyncRead, AsyncWrite, DuplexStream, ReadBuf},
    sync::mpsc,
};
use tokio_stream::wrappers::ReceiverStream;
use tonic::transport::{
    server::{Connected, Server},
    Endpoint, Uri,
};
use tower::service_fn;

use crate::wsl_link::{
    agent::WslLinkAgentService,
    noise_handshake::{perform_initiator_handshake, perform_responder_handshake},
    noise_material::generate_pairing_material,
    noise_stream::NoiseStream,
};

// ===== Proto 自动生成的 client / server stub =====
use crate::wsl_link::protocol::v1::{
    wsl_link_client::WslLinkClient,
    wsl_link_server::WslLinkServer,
    HeartbeatRequest,
    OpenSessionRequest,
};
// =============================================================

// =====================================================================
//  ConnectedDuplex: 把 DuplexStream 包成 tonic 可接受的 server-side IO。
// =====================================================================

pin_project! {
    /// `DuplexStream` 的透明 wrapper,实现 `tonic::transport::server::Connected`。
    /// 仅供 e2e 测试使用。
    pub(super) struct ConnectedDuplex {
        #[pin]
        inner: DuplexStream,
    }
}

impl ConnectedDuplex {
    fn new(inner: DuplexStream) -> Self {
        Self { inner }
    }
}

impl AsyncRead for ConnectedDuplex {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        self.project().inner.poll_read(cx, buf)
    }
}

impl AsyncWrite for ConnectedDuplex {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.project().inner.poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.project().inner.poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.project().inner.poll_shutdown(cx)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct InMemoryConnectInfo;

impl Connected for ConnectedDuplex {
    type ConnectInfo = InMemoryConnectInfo;

    fn connect_info(&self) -> Self::ConnectInfo {
        InMemoryConnectInfo
    }
}

// =====================================================================
//  E2eFixture: 一对 connected client + 后台 server。
// =====================================================================

struct E2eFixture {
    client: WslLinkClient<tonic::transport::Channel>,
    _server_task: tokio::task::JoinHandle<()>,
}

impl Drop for E2eFixture {
    fn drop(&mut self) {
        self._server_task.abort();
    }
}

/// 建立一对 Noise + tonic 的 in-process 连接,返回握手完成、可直接发 RPC 的 client。
async fn spawn_e2e_pair() -> E2eFixture {
    // ---- 1) 生成 Noise 配对材料 ----
    let pairing = generate_pairing_material().expect("generate pairing material");
    let init_config = pairing.desktop.initiator_config();
    let resp_config = pairing.agent.responder_config();

    // ---- 2) duplex 管道。缓冲区给足:最大 Noise 帧 ~64KB,握手期还会来回多帧 ----
    let (server_raw, client_raw) = duplex(256 * 1024);
    let server_side = ConnectedDuplex::new(server_raw);
    // 客户端不需要 Connected,直接用裸 DuplexStream

    // ---- 3) 服务端任务:responder 握手 → 把 NoiseStream 喂给 tonic server ----
    let (incoming_tx, incoming_rx) =
        mpsc::channel::<Result<NoiseStream<ConnectedDuplex>, io::Error>>(1);

    let server_task = tokio::spawn(async move {
        let (stream, transport) = perform_responder_handshake(server_side, &resp_config)
            .await
            .expect("responder handshake");

        let noise_stream = NoiseStream::new(stream, transport);

        // 单连接 fixture:握手一完成立刻送进 incoming,然后关闭 sender,
        // serve_with_incoming 处理完这一条连接后会自然结束。
        incoming_tx
            .send(Ok(noise_stream))
            .await
            .expect("send incoming");
        drop(incoming_tx);

        let svc = WslLinkServer::new(WslLinkAgentService::default());
        Server::builder()
            .add_service(svc)
            .serve_with_incoming(ReceiverStream::new(incoming_rx))
            .await
            .expect("tonic server serve");
    });

    // ---- 4) 客户端:initiator 握手(在前台 await,避免 oneshot 复杂度)----
    let (stream, transport) = perform_initiator_handshake(client_raw, &init_config)
        .await
        .expect("initiator handshake");

    let client_noise = NoiseStream::new(stream, transport);
    let mut client_noise_slot = Some(client_noise);

    // ---- 5) tonic Channel + 一次性 connector ----
    let channel = Endpoint::try_from("http://wsl-link.invalid")
        .expect("dummy endpoint")
        .connect_timeout(Duration::from_secs(5))
        .connect_with_connector(service_fn(move |_: Uri| {
            // connector 只会被 tonic 调用一次(单 channel + 不重连配置)。
            // 第二次取会 panic,正好暴露隐性 bug。
            let stream = client_noise_slot
                .take()
                .expect("tonic connector should only be invoked once");
            async move {
                Ok::<_, Infallible>(hyper_util::rt::TokioIo::new(stream))
            }
        }))
        .await
        .expect("tonic channel connect");

    E2eFixture {
        client: WslLinkClient::new(channel),
        _server_task: server_task,
    }
}

// =====================================================================
//  测试用例
// =====================================================================

/// Stage 3-A 的最小绿灯:一次完整 OpenSession RPC 走完 Noise → tonic 全链路。
#[tokio::test]
async fn e2e_open_session_completes_through_noise_channel() {
    let mut fixture = spawn_e2e_pair().await;

    // ⚠️ OpenSessionRequest 的字段名根据你 .proto 实际定义调整。
    // 这里假设至少有 client_id;如果还有 client_seq / resume_token 等,补上即可。
    let request = tonic::Request::new(OpenSessionRequest {
        client_id: "e2e-test-client".to_string(),
        ..Default::default()
    });

    let response = fixture
        .client
        .open_session(request)
        .await
        .expect("open_session RPC")
        .into_inner();

    assert!(
        !response.session_id.is_empty(),
        "OpenSession 必须返回非空 session_id"
    );
    // 按 agent.rs::open_session 当前契约继续断言:
    //   - response.transport.kind != Unspecified (VsockHyperv | VsockLinux)
    //   - response.ack_client_seq == 0 (新 session,尚未消费任何 client_seq)
    // assert_eq!(response.ack_client_seq, 0);
}

/// 验证 Heartbeat 在 Noise 通道上能往返,server_seq 单调递增。
#[tokio::test]
async fn e2e_heartbeat_advances_server_seq_over_noise() {
    let mut fixture = spawn_e2e_pair().await;

    let session_id = fixture
        .client
        .open_session(tonic::Request::new(OpenSessionRequest {
            client_id: "e2e-test-client".to_string(),
            ..Default::default()
        }))
        .await
        .expect("open_session")
        .into_inner()
        .session_id;

    let hb1 = fixture
        .client
        .heartbeat(tonic::Request::new(HeartbeatRequest {
            session_id: session_id.clone(),
            client_seq: 1,
            ..Default::default()
        }))
        .await
        .expect("heartbeat 1")
        .into_inner();

    let hb2 = fixture
        .client
        .heartbeat(tonic::Request::new(HeartbeatRequest {
            session_id,
            client_seq: 2,
            ..Default::default()
        }))
        .await
        .expect("heartbeat 2")
        .into_inner();

    assert!(
        hb2.server_seq > hb1.server_seq,
        "server_seq 必须单调递增: hb1={}, hb2={}",
        hb1.server_seq,
        hb2.server_seq
    );
    assert_eq!(hb2.ack_client_seq, 2, "ack_client_seq 必须追上最新 client_seq");
}

/// Stage 3-A 高价值断言:Duplex bidi-streaming 在 Noise 上正确路由 + 回包。
/// 完整实现依赖 `dispatch_terminal!` 的当前路由契约,先留 todo 占位。
#[tokio::test]
#[ignore = "Stage 3-A 后续:补 Duplex echo 用例,依赖 dispatch_terminal! 当前路由"]
async fn e2e_duplex_echo_round_trip() {
    let _fixture = spawn_e2e_pair().await;
    todo!("根据 agent.rs::duplex 的当前路由实现 echo 双向往返");
}