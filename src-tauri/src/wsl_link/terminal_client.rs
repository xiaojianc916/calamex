use thiserror::Error;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::Request;

use super::{
    config::WslLinkTransportConfig,
    grpc_transport::WslLinkGrpcTransportError,
    noise_material::WslLinkDesktopNoiseMaterial,
    primary_supervisor::{WslLinkPrimarySupervisor, WslLinkPrimarySupervisorError},
    protocol::v1::ClientFrame,
    terminal_exec::{
        decode_terminal_server_payload, encode_terminal_client_payload,
        WslLinkTerminalClientPayload, WslLinkTerminalExecError, WslLinkTerminalInteractiveClose,
        WslLinkTerminalInteractiveInput, WslLinkTerminalInteractiveResize,
        WslLinkTerminalOpenInteractiveRequest, WslLinkTerminalRunInput,
        WslLinkTerminalRunScriptRequest, WslLinkTerminalServerPayload,
        WslLinkTerminalSignalProcess,
    },
    types::now_unix_ms,
};

#[derive(Debug, Error)]
pub enum WslLinkTerminalClientError {
    #[error("WSL Link terminal gRPC 失败：{0}")]
    Grpc(#[from] WslLinkGrpcTransportError),
    #[error("WSL Link terminal supervisor 失败：{0}")]
    Supervisor(#[from] WslLinkPrimarySupervisorError),
    #[error("WSL Link terminal stream 失败：{0}")]
    Status(#[from] tonic::Status),
    #[error("WSL Link terminal payload 失败：{0}")]
    Payload(#[from] WslLinkTerminalExecError),
    #[error("WSL Link terminal 响应 session 不匹配。")]
    SessionMismatch,
    #[error("WSL Link interactive command channel 已关闭。")]
    CommandChannelClosed,
}

#[derive(Debug)]
enum WslLinkInteractiveTerminalCommand {
    Input(WslLinkTerminalInteractiveInput),
    Close(WslLinkTerminalInteractiveClose),
}

#[derive(Debug, Clone)]
pub struct WslLinkInteractiveTerminalHandle {
    session_id: String,
    /// bounded channel for Input / Close（容量 64）
    command_tx: mpsc::Sender<WslLinkInteractiveTerminalCommand>,
    /// watch channel for Resize（只保留最新值）
    resize_tx: tokio::sync::watch::Sender<(u16, u16)>,
}

impl WslLinkInteractiveTerminalHandle {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub async fn write_input(&self, data: String) -> Result<(), WslLinkTerminalClientError> {
        // send().await 保证背压：通道满时阻塞等待，绝不静默丢字符
        self.command_tx
            .send(WslLinkInteractiveTerminalCommand::Input(
                WslLinkTerminalInteractiveInput {
                    session_id: self.session_id.clone(),
                    data,
                },
            ))
            .await
            .map_err(|_| WslLinkTerminalClientError::CommandChannelClosed)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), WslLinkTerminalClientError> {
        // watch: 覆盖旧值，不阻塞，拖拽中间态丢弃是正确行为
        let _ = self.resize_tx.send((cols, rows));
        Ok(())
    }

    pub fn close(&self) -> Result<(), WslLinkTerminalClientError> {
        // try_send: close 是 fire-and-forget 信号，通道满说明 task 已跟不上
        self.command_tx
            .try_send(WslLinkInteractiveTerminalCommand::Close(
                WslLinkTerminalInteractiveClose {
                    session_id: self.session_id.clone(),
                },
            ))
            .map_err(|_| WslLinkTerminalClientError::CommandChannelClosed)
    }
}

pub async fn run_terminal_script_over_wsl_link<F>(
    desktop_material: &WslLinkDesktopNoiseMaterial,
    request: WslLinkTerminalRunScriptRequest,
    on_event: F,
) -> Result<(), WslLinkTerminalClientError>
where
    F: FnMut(WslLinkTerminalServerPayload),
{
    request.validate()?;
    // 改动 2: 提前借出 run_id,避免克隆整个含 script_content 的 request。
    let run_id = request.run_id.clone();
    execute_one_shot_terminal_rpc(
        "calamex-desktop-terminal",
        "wsl-link-terminal",
        "terminal-run",
        desktop_material,
        WslLinkTerminalClientPayload::RunScript(request),
        move |_client_seq| run_id,
        |payload| {
            matches!(
                payload,
                WslLinkTerminalServerPayload::RunCompleted(_)
                    | WslLinkTerminalServerPayload::RunError(_)
            )
        },
        on_event,
    )
    .await
}

pub async fn signal_terminal_process_over_wsl_link(
    desktop_material: &WslLinkDesktopNoiseMaterial,
    request: WslLinkTerminalSignalProcess,
) -> Result<(), WslLinkTerminalClientError> {
    request.validate()?;
    execute_one_shot_terminal_rpc(
        "calamex-desktop-terminal-signal",
        "wsl-link-terminal-signal",
        "terminal-signal",
        desktop_material,
        WslLinkTerminalClientPayload::SignalProcess(request),
        |client_seq| format!("terminal-signal-{client_seq}"),
        |payload| {
            matches!(
                payload,
                WslLinkTerminalServerPayload::InteractiveAck(_)
                    | WslLinkTerminalServerPayload::InteractiveError(_)
            )
        },
        |_| {},
    )
    .await
}

pub async fn write_terminal_run_input_over_wsl_link(
    desktop_material: &WslLinkDesktopNoiseMaterial,
    request: WslLinkTerminalRunInput,
) -> Result<(), WslLinkTerminalClientError> {
    request.validate()?;
    // 改动 2: 同 run_script,run_input 也提前借出 run_id。
    let run_id = request.run_id.clone();
    execute_one_shot_terminal_rpc(
        "calamex-desktop-terminal-run-input",
        "wsl-link-terminal-run-input",
        "terminal-run-input",
        desktop_material,
        WslLinkTerminalClientPayload::RunInput(request),
        move |client_seq| format!("terminal-run-input-{run_id}-{client_seq}"),
        |payload| {
            matches!(
                payload,
                WslLinkTerminalServerPayload::InteractiveAck(_)
                    | WslLinkTerminalServerPayload::InteractiveError(_)
            )
        },
        |_| {},
    )
    .await
}

pub async fn open_interactive_terminal_over_wsl_link<F>(
    desktop_material: &WslLinkDesktopNoiseMaterial,
    request: WslLinkTerminalOpenInteractiveRequest,
    mut on_event: F,
) -> Result<WslLinkInteractiveTerminalHandle, WslLinkTerminalClientError>
where
    F: FnMut(WslLinkTerminalServerPayload) + Send + 'static,
{
    request.validate()?;
    let terminal_session_id = request.session_id.clone();

    let mut supervisor = WslLinkPrimarySupervisor::new(
        "calamex-desktop-interactive-terminal",
        WslLinkTransportConfig::default(),
    );
    let mut connection = supervisor.open_noise_connection(desktop_material).await?;
    let wsl_link_session_id = connection.session.session_id.clone();

    let (frame_tx, frame_rx) = mpsc::channel::<ClientFrame>(32);
    let response = connection
        .client
        .duplex(Request::new(ReceiverStream::new(frame_rx)))
        .await?;

    send_terminal_payload_frame(
        &mut supervisor,
        &frame_tx,
        &wsl_link_session_id,
        format!("interactive-open-{terminal_session_id}"),
        WslLinkTerminalClientPayload::OpenInteractive(request),
    )
    .await?;

    let (command_tx, mut command_rx) =
        mpsc::channel::<WslLinkInteractiveTerminalCommand>(64);
    let (resize_tx, mut resize_rx) = tokio::sync::watch::channel((0u16, 0u16));
    let handle = WslLinkInteractiveTerminalHandle {
        session_id: terminal_session_id,
        command_tx,
        resize_tx,
    };

    tokio::spawn(async move {
        let mut stream = response.into_inner();
        loop {
            tokio::select! {
                command = command_rx.recv() => {
                    let Some(command) = command else {
                        break;
                    };
                    let (request_id, payload) = match command {
                        WslLinkInteractiveTerminalCommand::Input(payload) => (
                            format!("interactive-input-{}-{}", payload.session_id, now_unix_ms()),
                            WslLinkTerminalClientPayload::InteractiveInput(payload),
                        ),
                        WslLinkInteractiveTerminalCommand::Close(payload) => (
                            format!("interactive-close-{}-{}", payload.session_id, now_unix_ms()),
                            WslLinkTerminalClientPayload::InteractiveClose(payload),
                        ),
                    };
                    if send_terminal_payload_frame(
                        &mut supervisor,
                        &frame_tx,
                        &wsl_link_session_id,
                        request_id,
                        payload,
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
                _ = resize_rx.changed() => {
                    let (cols, rows) = *resize_rx.borrow_and_update();
                    if cols == 0 && rows == 0 {
                        continue;
                    }
                    let payload = WslLinkTerminalInteractiveResize {
                        session_id: wsl_link_session_id.clone(),
                        cols,
                        rows,
                    };
                    let request_id = format!(
                        "interactive-resize-{}-{}",
                        payload.session_id, now_unix_ms()
                    );
                    if send_terminal_payload_frame(
                        &mut supervisor,
                        &frame_tx,
                        &wsl_link_session_id,
                        request_id,
                        WslLinkTerminalClientPayload::InteractiveResize(payload),
                    )
                    .await
                    .is_err()
                    {
                        break;
                    }
                }
                message = stream.message() => {
                    let frame = match message {
                        Ok(Some(frame)) => frame,
                        Ok(None) => break,
                        Err(_) => break,
                    };
                    if frame.session_id != wsl_link_session_id {
                        break;
                    }
                    supervisor.apply_server_frame_ack(frame.server_seq, frame.ack_client_seq);
                    let Ok(payload) = decode_terminal_server_payload(&frame.payload) else {
                        break;
                    };
                    let is_finished = matches!(
                        &payload,
                        WslLinkTerminalServerPayload::InteractiveClosed(_)
                            | WslLinkTerminalServerPayload::InteractiveError(_)
                    );
                    on_event(payload);
                    if is_finished {
                        break;
                    }
                }
            }
        }
        drop(frame_tx);
    });

    Ok(handle)
}

// 改动 1: 把 3 个 one-shot RPC 共通的流水线集中到这里。
//
// 流水线步骤:
//   1. 用给定 client_id 新建一次性 supervisor + Noise 连接;
//   2. 分配 client_seq,生成 trace_id = "{trace_prefix}-{now_unix_ms}";
//   3. 编码 payload,组装一帧 ClientFrame:
//        - request_id 由 request_id_for_seq(client_seq) 决定;
//        - idempotency_key = "{idempotency_prefix}-{client_seq}";
//   4. 通过 duplex 发送单帧请求,流式消费服务端响应;
//   5. 每收到一帧:校验 session_id、推进 supervisor ack 状态、解码 payload、
//      回调 on_event,直到 is_finished(payload) 返回 true 后退出。
//
// 改动 4: 与 interactive 路径对齐,在 helper 内统一调用 apply_server_frame_ack。
// 由于 supervisor 在函数返回时就被丢弃,这一调用没有外部可观测效果,但消除了
// "interactive 路径维护 ack 状态、one-shot 路径不维护" 的不一致认知负担。
async fn execute_one_shot_terminal_rpc<RID, FIN, EVT>(
    client_id: &'static str,
    trace_prefix: &'static str,
    idempotency_prefix: &'static str,
    desktop_material: &WslLinkDesktopNoiseMaterial,
    payload: WslLinkTerminalClientPayload,
    request_id_for_seq: RID,
    is_finished: FIN,
    mut on_event: EVT,
) -> Result<(), WslLinkTerminalClientError>
where
    RID: FnOnce(u64) -> String,
    FIN: Fn(&WslLinkTerminalServerPayload) -> bool,
    EVT: FnMut(WslLinkTerminalServerPayload),
{
    let mut supervisor =
        WslLinkPrimarySupervisor::new(client_id, WslLinkTransportConfig::default());
    let mut connection = supervisor.open_noise_connection(desktop_material).await?;
    let session_id = connection.session.session_id.clone();
    let client_seq = supervisor.allocate_client_seq();
    let trace_id = format!("{trace_prefix}-{}", now_unix_ms());
    let encoded_payload = encode_terminal_client_payload(&payload)?;
    let frame = ClientFrame {
        session_id: session_id.clone(),
        request_id: request_id_for_seq(client_seq),
        idempotency_key: format!("{idempotency_prefix}-{client_seq}"),
        client_seq,
        ack_server_seq: supervisor.last_ack_server_seq(),
        payload: encoded_payload,
        trace_id,
    };
    let response = connection
        .client
        .duplex(Request::new(tokio_stream::iter([frame])))
        .await?;
    let mut stream = response.into_inner();
    while let Some(frame) = stream.message().await? {
        if frame.session_id != session_id {
            return Err(WslLinkTerminalClientError::SessionMismatch);
        }
        supervisor.apply_server_frame_ack(frame.server_seq, frame.ack_client_seq);
        let payload = decode_terminal_server_payload(&frame.payload)?;
        let finished = is_finished(&payload);
        on_event(payload);
        if finished {
            break;
        }
    }
    Ok(())
}

async fn send_terminal_payload_frame(
    supervisor: &mut WslLinkPrimarySupervisor,
    frame_tx: &mpsc::Sender<ClientFrame>,
    session_id: &str,
    request_id: String,
    payload: WslLinkTerminalClientPayload,
) -> Result<(), WslLinkTerminalClientError> {
    let client_seq = supervisor.allocate_client_seq();
    let trace_id = format!("wsl-link-terminal-{}", now_unix_ms());
    let payload = encode_terminal_client_payload(&payload)?;
    frame_tx
        .send(ClientFrame {
            session_id: session_id.to_string(),
            request_id,
            idempotency_key: format!("terminal-frame-{client_seq}"),
            client_seq,
            ack_server_seq: supervisor.last_ack_server_seq(),
            payload,
            trace_id,
        })
        .await
        .map_err(|_| WslLinkTerminalClientError::CommandChannelClosed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_request_validation_rejects_empty_run_id() {
        let request = WslLinkTerminalRunScriptRequest {
            run_id: String::new(),
            working_directory: "/tmp".to_string(),
            execution_path: "/tmp/test.sh".to_string(),
            script_content: Some("echo hi".to_string()),
            cleanup_paths: vec![],
            cols: 120,
            rows: 40,
        };
        assert!(request.validate().is_err());
    }
}