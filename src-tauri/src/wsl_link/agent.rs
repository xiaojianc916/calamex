use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tonic::{Request, Response, Status};

use super::{
    protocol::v1::{
        wsl_link_server::WslLink, ClientFrame, HeartbeatRequest, HeartbeatResponse,
        OpenSessionRequest, OpenSessionResponse, ResumeSessionRequest, ResumeSessionResponse,
        ServerFrame, TransportKind,
    },
    terminal_exec::{
        decode_terminal_client_payload, encode_terminal_server_payload,
        resolve_agent_working_directory, WslLinkTerminalClientPayload,
        WslLinkTerminalInteractiveAck, WslLinkTerminalInteractiveClose,
        WslLinkTerminalInteractiveClosed, WslLinkTerminalInteractiveData,
        WslLinkTerminalInteractiveError, WslLinkTerminalInteractiveInput,
        WslLinkTerminalInteractiveOpened, WslLinkTerminalInteractiveResize,
        WslLinkTerminalOpenInteractiveRequest, WslLinkTerminalRunChunk,
        WslLinkTerminalRunCompleted, WslLinkTerminalRunError, WslLinkTerminalRunInput,
        WslLinkTerminalRunScriptRequest, WslLinkTerminalRunStarted, WslLinkTerminalServerPayload,
        WslLinkTerminalSignalProcess, WslLinkUtf8ChunkDecoder,
    },
    types::{now_unix_ms, DEFAULT_PROTOCOL_VERSION},
};

type DuplexStream =
    tonic::codegen::tokio_stream::wrappers::ReceiverStream<Result<ServerFrame, Status>>;

const AGENT_INTERACTIVE_SHELL: &str = "/bin/bash";
const AGENT_INTERACTIVE_SHELL_LOGIN_ARG: &str = "-il";
const AGENT_INTERACTIVE_TERM: &str = "xterm-256color";
const AGENT_INTERACTIVE_COLORTERM: &str = "truecolor";
const AGENT_INTERACTIVE_LOCALE: &str = "C.UTF-8";
const AGENT_PROCESS_SIGNAL_COMMAND: &str = "/bin/kill";
const MAX_RESPONSE_CACHE_ENTRIES: usize = 1024;

#[derive(Debug, Clone)]
struct AgentSession {
    session_id: String,
    server_seq: u64,
    ack_client_seq: u64,
    /// 写请求按 client_seq 去重缓存。普通路径 Vec 长度恒为 1;
    /// terminal 流式路径 Vec 持续 append。
    /// FIFO 顺序由 `cache_order` 维护,超过 `MAX_RESPONSE_CACHE_ENTRIES` 会淘汰最旧的。
    response_cache_by_client_seq: HashMap<u64, Vec<ServerFrame>>,
    cache_order: VecDeque<u64>,
}

impl AgentSession {
    fn new(session_id: String, last_client_seq: u64) -> Self {
        Self {
            session_id,
            server_seq: 1,
            ack_client_seq: last_client_seq,
            response_cache_by_client_seq: HashMap::new(),
            cache_order: VecDeque::new(),
        }
    }

    fn next_server_seq(&mut self) -> u64 {
        let current = self.server_seq;
        self.server_seq = self.server_seq.saturating_add(1);
        current
    }

    fn ack_client_seq(&mut self, client_seq: u64) {
        self.ack_client_seq = self.ack_client_seq.max(client_seq);
    }

    fn cache_insert(&mut self, client_seq: u64, frames: Vec<ServerFrame>) {
        if self.response_cache_by_client_seq.insert(client_seq, frames).is_none() {
            self.cache_order.push_back(client_seq);
            while self.cache_order.len() > MAX_RESPONSE_CACHE_ENTRIES {
                if let Some(oldest) = self.cache_order.pop_front() {
                    self.response_cache_by_client_seq.remove(&oldest);
                }
            }
        }
    }
}

struct AgentInteractivePty {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    is_alive: AtomicBool,
}

impl AgentInteractivePty {
    fn write_input(&self, data: &str) -> Result<(), Status> {
        if !self.is_alive.load(Ordering::SeqCst) {
            return Err(Status::failed_precondition("交互终端已退出。"));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| Status::internal("交互终端写入通道已损坏。"))?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| Status::internal(format!("写入交互终端失败：{error}")))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), Status> {
        if !self.is_alive.load(Ordering::SeqCst) {
            return Err(Status::failed_precondition("交互终端已退出。"));
        }
        let master = self
            .master
            .lock()
            .map_err(|_| Status::internal("交互终端尺寸通道已损坏。"))?;
        master
            .resize(agent_pty_size(cols, rows))
            .map_err(|error| Status::internal(format!("同步交互终端尺寸失败：{error}")))
    }

    fn terminate(&self) -> Result<(), Status> {
        self.is_alive.store(false, Ordering::SeqCst);
        let mut killer = self
            .killer
            .lock()
            .map_err(|_| Status::internal("交互终端结束通道已损坏。"))?;
        killer
            .kill()
            .map_err(|error| Status::internal(format!("关闭交互终端失败：{error}")))
    }
}

#[derive(Default)]
struct AgentState {
    next_session_seq: u64,
    sessions: HashMap<String, AgentSession>,
    interactive_sessions: HashMap<String, Arc<AgentInteractivePty>>,
    active_run_inputs: HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>,
}

impl AgentState {
    fn create_session(&mut self, last_client_seq: u64) -> (AgentSession, u64) {
        self.next_session_seq = self.next_session_seq.saturating_add(1);
        let session_id = format!("wsl-link-session-{}", self.next_session_seq);
        let mut session = AgentSession::new(session_id.clone(), last_client_seq);
        let initial_server_seq = session.next_server_seq();
        self.sessions.insert(session_id, session.clone());
        (session, initial_server_seq)
    }

    fn get_session_mut(&mut self, session_id: &str) -> Option<&mut AgentSession> {
        self.sessions.get_mut(session_id)
    }
}

// Stage 2 改造:Noise 已下沉到传输层 (见 noise_handshake.rs + agent_runtime.rs),
// service 不再持有密钥材料,只做应用层会话状态管理。
#[derive(Clone, Default)]
pub struct WslLinkAgentService {
    state: Arc<Mutex<AgentState>>,
}

impl WslLinkAgentService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn handle_client_frame(&self, frame: ClientFrame) -> Result<ServerFrame, Status> {
        build_server_frame_with_state(&self.state, frame)
            .unwrap_or_else(|| Err(Status::internal("WSL Link agent 状态锁已损坏。")))
    }

    fn open_session_response(
        &self,
        request: OpenSessionRequest,
    ) -> Result<OpenSessionResponse, Status> {
        if request.client_id.trim().is_empty() {
            return Err(Status::invalid_argument("client_id 不能为空。"));
        }
        if request.protocol_version != DEFAULT_PROTOCOL_VERSION {
            return Err(Status::failed_precondition("WSL Link 协议版本不匹配。"));
        }
        if request.trace_id.trim().is_empty() {
            return Err(Status::invalid_argument("trace_id 不能为空。"));
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
        let (session, server_seq) = state.create_session(request.last_client_seq);
        Ok(OpenSessionResponse {
            session_id: session.session_id,
            server_seq,
            ack_client_seq: session.ack_client_seq,
            transport: TransportKind::VsockGrpc as i32,
        })
    }
}

#[tonic::async_trait]
impl WslLink for WslLinkAgentService {
    async fn open_session(
        &self,
        request: Request<OpenSessionRequest>,
    ) -> Result<Response<OpenSessionResponse>, Status> {
        Ok(Response::new(
            self.open_session_response(request.into_inner())?,
        ))
    }

    async fn resume_session(
        &self,
        request: Request<ResumeSessionRequest>,
    ) -> Result<Response<ResumeSessionResponse>, Status> {
        let request = request.into_inner();
        if request.session_id.trim().is_empty() {
            return Err(Status::invalid_argument("session_id 不能为空。"));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
        let Some(session) = state.get_session_mut(&request.session_id) else {
            return Ok(Response::new(ResumeSessionResponse {
                accepted: false,
                server_seq: 0,
                ack_client_seq: 0,
                reason: "session 不存在，需要重新 OpenSession。".to_string(),
            }));
        };
        session.ack_client_seq(request.last_client_seq);
        // 返回当前可用的 server_seq,内部状态推进到 +1 供下次使用
        let server_seq = session
            .server_seq
            .max(request.last_ack_server_seq.saturating_add(1));
        session.server_seq = server_seq.saturating_add(1);
        Ok(Response::new(ResumeSessionResponse {
            accepted: true,
            server_seq,
            ack_client_seq: session.ack_client_seq,
            reason: "已恢复。".to_string(),
        }))
    }

    async fn heartbeat(
        &self,
        request: Request<HeartbeatRequest>,
    ) -> Result<Response<HeartbeatResponse>, Status> {
        let request = request.into_inner();
        let mut state = self
            .state
            .lock()
            .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
        let Some(session) = state.get_session_mut(&request.session_id) else {
            return Err(Status::not_found("session 不存在。"));
        };
        session.ack_client_seq(request.client_seq);
        let server_seq = session.next_server_seq();
        Ok(Response::new(HeartbeatResponse {
            session_id: request.session_id,
            server_seq,
            ack_client_seq: session.ack_client_seq,
            received_at_unix_ms: now_unix_ms_i64(),
        }))
    }

    type DuplexStream = DuplexStream;

    async fn duplex(
        &self,
        request: Request<tonic::Streaming<ClientFrame>>,
    ) -> Result<Response<Self::DuplexStream>, Status> {
        let mut inbound = request.into_inner();
        let state = Arc::clone(&self.state);
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            loop {
                let frame = match inbound.message().await {
                    Ok(Some(frame)) => frame,
                    Ok(None) => break,
                    Err(error) => {
                        let _ = tx
                            .send(Err(Status::internal(format!(
                                "读取 WSL Link duplex frame 失败：{error}"
                            ))))
                            .await;
                        break;
                    }
                };

                if handle_terminal_duplex_frame(&state, frame.clone(), &tx).await {
                    continue;
                }

                match build_server_frame_with_state(&state, frame) {
                    Some(response) => {
                        if tx.send(response).await.is_err() {
                            break;
                        }
                    }
                    None => {
                        let _ = tx
                            .send(Err(Status::internal("WSL Link agent 状态锁已损坏。")))
                            .await;
                        break;
                    }
                }
            }
        });

        Ok(Response::new(
            tonic::codegen::tokio_stream::wrappers::ReceiverStream::new(rx),
        ))
    }
}

fn build_server_frame_with_state(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
) -> Option<Result<ServerFrame, Status>> {
    let mut state = state.lock().ok()?;
    Some(build_server_frame(&mut state, frame))
}

fn build_server_frame(state: &mut AgentState, frame: ClientFrame) -> Result<ServerFrame, Status> {
    if frame.session_id.trim().is_empty() {
        return Err(Status::invalid_argument("session_id 不能为空。"));
    }
    if frame.request_id.trim().is_empty() {
        return Err(Status::invalid_argument("request_id 不能为空。"));
    }
    // 写请求的幂等边界固定为同一个 session 内的 client_seq。
    // idempotency_key 仍保留在协议里，供上层审计或未来兼容旧客户端。
    if frame.client_seq == 0 {
        return Err(Status::invalid_argument("client_seq 必须从 1 开始。"));
    }
    let Some(session) = state.get_session_mut(&frame.session_id) else {
        return Err(Status::not_found("session 不存在。"));
    };
    if let Some(cached) = session
        .response_cache_by_client_seq
        .get(&frame.client_seq)
        .cloned()
    {
        session.ack_client_seq(frame.client_seq);
        let Some(mut response) = cached.first().cloned() else {
            return Err(Status::internal("WSL Link agent 去重缓存为空。"));
        };
        response.ack_client_seq = session.ack_client_seq;
        return Ok(response);
    }
    session.ack_client_seq(frame.client_seq);
    let server_seq = session.next_server_seq();
    let response = ServerFrame {
        session_id: frame.session_id,
        request_id: frame.request_id,
        server_seq,
        ack_client_seq: session.ack_client_seq,
        payload: frame.payload,
        trace_id: frame.trace_id,
    };
    session.cache_insert(frame.client_seq, vec![response.clone()]);
    Ok(response)
}

#[derive(Debug, Clone)]
struct TerminalFrameMeta {
    session_id: String,
    request_id: String,
    trace_id: String,
    client_seq: u64,
}

// 把 7 个同构分支收敛进一个宏 —— 每个 handler 返回 Result,失败统一转发到 tx
macro_rules! dispatch_terminal {
    ($handler:expr, $tx:expr) => {{
        if let Err(error) = $handler.await {
            let _ = $tx.send(Err(error)).await;
        }
        true
    }};
}

async fn handle_terminal_duplex_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> bool {
    let Ok(payload) = decode_terminal_client_payload(&frame.payload) else {
        return false;
    };
    match payload {
        WslLinkTerminalClientPayload::RunScript(request) => {
            dispatch_terminal!(run_terminal_script_frame(state, frame, request, tx), tx)
        }
        WslLinkTerminalClientPayload::RunInput(request) => {
            dispatch_terminal!(write_terminal_run_input_frame(state, frame, request, tx), tx)
        }
        WslLinkTerminalClientPayload::OpenInteractive(request) => {
            dispatch_terminal!(open_interactive_terminal_frame(state, frame, request, tx), tx)
        }
        WslLinkTerminalClientPayload::InteractiveInput(request) => {
            dispatch_terminal!(write_interactive_terminal_frame(state, frame, request, tx), tx)
        }
        WslLinkTerminalClientPayload::InteractiveResize(request) => {
            dispatch_terminal!(resize_interactive_terminal_frame(state, frame, request, tx), tx)
        }
        WslLinkTerminalClientPayload::InteractiveClose(request) => {
            dispatch_terminal!(close_interactive_terminal_frame(state, frame, request, tx), tx)
        }
        WslLinkTerminalClientPayload::SignalProcess(request) => {
            dispatch_terminal!(signal_process_frame(state, frame, request, tx), tx)
        }
    }
}

async fn run_terminal_script_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalRunScriptRequest,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    if let Some(content) = request.script_content.as_ref() {
        tokio::fs::write(&request.execution_path, content)
            .await
            .map_err(|error| Status::internal(format!("写入 WSL Link 临时脚本失败：{error}")))?;
        set_private_file_permissions(&request.execution_path).await?;
    }

    let working_directory = resolve_agent_working_directory(&request.working_directory)
        .map_err(|error| Status::invalid_argument(error.to_string()))?;

    let mut command = tokio::process::Command::new("/usr/bin/setsid");
    command
        .arg("--wait")
        .arg("/usr/bin/env")
        .arg("LANG=C.UTF-8")
        .arg("LC_ALL=C.UTF-8")
        .arg("TERM=xterm-256color")
        .arg("/bin/bash")
        .arg("--noprofile")
        .arg("--norc")
        .arg(&request.execution_path)
        .current_dir(working_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| Status::internal(format!("启动 WSL Link 脚本失败：{error}")))?;
    let pid = child.id().unwrap_or(0);
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| Status::internal("WSL Link 脚本 stdin 不可用。"))?;

    let (input_tx, input_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::RunStarted(WslLinkTerminalRunStarted {
            run_id: request.run_id.clone(),
            pid,
            started_at_unix_ms: now_unix_ms_i64(),
        }),
        tx,
    )
    .await?;

    register_terminal_run_input(state, &request.run_id, input_tx)?;

    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<TerminalProcessEvent>(32);
    tokio::spawn(write_process_stdin(
        request.run_id.clone(),
        stdin,
        input_rx,
        event_tx.clone(),
    ));
    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(read_process_stream(stdout, event_tx.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(read_process_stream(stderr, event_tx.clone()));
    }

    tokio::spawn(async move {
        let exit = child
            .wait()
            .await
            .map(|status| status.code())
            .map_err(|error| error.to_string());
        let _ = event_tx.send(TerminalProcessEvent::Exit(exit)).await;
    });

    let mut exit_code = None;
    let mut wait_error = None;
    while let Some(event) = event_rx.recv().await {
        match event {
            TerminalProcessEvent::Chunk(data) => {
                send_terminal_event(
                    state,
                    &meta,
                    WslLinkTerminalServerPayload::RunChunk(WslLinkTerminalRunChunk {
                        run_id: request.run_id.clone(),
                        data,
                    }),
                    tx,
                )
                .await?;
            }
            TerminalProcessEvent::Exit(Ok(code)) => exit_code = code,
            TerminalProcessEvent::Exit(Err(error)) => wait_error = Some(error),
        }
    }

    remove_terminal_run_input(state, &request.run_id);
    cleanup_terminal_run_files(&request.cleanup_paths).await;

    if let Some(error) = wait_error {
        send_terminal_event(
            state,
            &meta,
            WslLinkTerminalServerPayload::RunError(WslLinkTerminalRunError {
                run_id: request.run_id,
                message: format!("等待 WSL Link 脚本结束失败：{error}"),
                exit_code,
                finished_at_unix_ms: now_unix_ms_i64(),
            }),
            tx,
        )
        .await?;
        return Ok(());
    }

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::RunCompleted(WslLinkTerminalRunCompleted {
            run_id: request.run_id,
            exit_code,
            finished_at_unix_ms: now_unix_ms_i64(),
        }),
        tx,
    )
    .await
}

async fn write_terminal_run_input_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalRunInput,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    let input = get_terminal_run_input(state, &request.run_id)?;
    input
        .send(request.data)
        .map_err(|_| Status::failed_precondition("WSL Link 脚本输入通道已关闭。"))?;

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::InteractiveAck(WslLinkTerminalInteractiveAck {
            session_id: None,
            action: "run_input".to_string(),
        }),
        tx,
    )
    .await
}

async fn open_interactive_terminal_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalOpenInteractiveRequest,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    let key = terminal_session_key(&meta.session_id, &request.session_id);
    let working_directory = resolve_agent_working_directory(&request.working_directory)
        .map_err(|error| Status::invalid_argument(error.to_string()))?;

    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(agent_pty_size(request.cols, request.rows))
        .map_err(|error| Status::internal(format!("创建 WSL Link 交互 PTY 失败：{error}")))?;

    let mut command = CommandBuilder::new(AGENT_INTERACTIVE_SHELL);
    command.arg(AGENT_INTERACTIVE_SHELL_LOGIN_ARG);
    command.cwd(&working_directory);
    command.env("TERM", AGENT_INTERACTIVE_TERM);
    command.env("COLORTERM", AGENT_INTERACTIVE_COLORTERM);
    command.env("LANG", AGENT_INTERACTIVE_LOCALE);
    command.env("LC_ALL", AGENT_INTERACTIVE_LOCALE);

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| Status::internal(format!("启动 WSL Link 交互终端失败：{error}")))?;
    let pid = child.process_id().unwrap_or(0);
    let killer = child.clone_killer();
    drop(pty_pair.slave);

    let reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| Status::internal(format!("初始化交互终端读通道失败：{error}")))?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|error| Status::internal(format!("初始化交互终端写通道失败：{error}")))?;

    let pty = Arc::new(AgentInteractivePty {
        master: Mutex::new(pty_pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(killer),
        is_alive: AtomicBool::new(true),
    });

    {
        let mut state_guard = state
            .lock()
            .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
        if let Some(existing) = state_guard.interactive_sessions.remove(&key) {
            let _ = existing.terminate();
        }
        state_guard
            .interactive_sessions
            .insert(key.clone(), Arc::clone(&pty));
    }

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::InteractiveOpened(WslLinkTerminalInteractiveOpened {
            session_id: request.session_id.clone(),
            cwd: request.working_directory.clone(),
            pid,
            opened_at_unix_ms: now_unix_ms_i64(),
        }),
        tx,
    )
    .await?;

    spawn_interactive_reader(
        Arc::clone(state),
        meta.clone(),
        request.session_id.clone(),
        reader,
        tx.clone(),
    );
    spawn_interactive_waiter(state, meta, key, request.session_id, child, pty, tx.clone());
    Ok(())
}

async fn write_interactive_terminal_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalInteractiveInput,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    let pty = get_interactive_pty(state, &meta.session_id, &request.session_id)?;
    pty.write_input(&request.data)?;

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::InteractiveAck(WslLinkTerminalInteractiveAck {
            session_id: Some(request.session_id),
            action: "input".to_string(),
        }),
        tx,
    )
    .await
}

async fn resize_interactive_terminal_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalInteractiveResize,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    let pty = get_interactive_pty(state, &meta.session_id, &request.session_id)?;
    pty.resize(request.cols, request.rows)?;

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::InteractiveAck(WslLinkTerminalInteractiveAck {
            session_id: Some(request.session_id),
            action: "resize".to_string(),
        }),
        tx,
    )
    .await
}

async fn close_interactive_terminal_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalInteractiveClose,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    let key = terminal_session_key(&meta.session_id, &request.session_id);
    let pty = {
        let mut state_guard = state
            .lock()
            .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
        state_guard.interactive_sessions.remove(&key)
    };
    if let Some(pty) = pty {
        let _ = pty.terminate();
    }

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::InteractiveAck(WslLinkTerminalInteractiveAck {
            session_id: Some(request.session_id),
            action: "close".to_string(),
        }),
        tx,
    )
    .await
}

async fn signal_process_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
    request: WslLinkTerminalSignalProcess,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    request
        .validate()
        .map_err(|error| Status::invalid_argument(error.to_string()))?;
    let session_id = frame.session_id.clone();
    let client_seq = frame.client_seq;
    let Some(meta) = begin_terminal_frame(state, frame)? else {
        return replay_cached_terminal_frames(state, &session_id, client_seq, tx).await;
    };

    let signal = if request.mode == "kill" { "KILL" } else { "TERM" };
    let target = format!("-{}", request.pid);
    let status = tokio::process::Command::new(AGENT_PROCESS_SIGNAL_COMMAND)
        .arg(format!("-{signal}"))
        .arg("--")
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .status()
        .await
        .map_err(|error| Status::internal(format!("发送进程信号失败：{error}")))?;

    if !status.success() {
        return Err(Status::internal("发送进程信号失败。"));
    }

    send_terminal_event(
        state,
        &meta,
        WslLinkTerminalServerPayload::InteractiveAck(WslLinkTerminalInteractiveAck {
            session_id: None,
            action: "signal_process".to_string(),
        }),
        tx,
    )
    .await
}

// 合并 begin_terminal_run_frame + begin_terminal_control_frame —— 各自 request.validate()
// 提前到调用方调用,这里只做 frame 基础校验 + 幂等占位。
fn begin_terminal_frame(
    state: &Arc<Mutex<AgentState>>,
    frame: ClientFrame,
) -> Result<Option<TerminalFrameMeta>, Status> {
    if frame.session_id.trim().is_empty() {
        return Err(Status::invalid_argument("session_id 不能为空。"));
    }
    if frame.request_id.trim().is_empty() {
        return Err(Status::invalid_argument("request_id 不能为空。"));
    }
    if frame.client_seq == 0 {
        return Err(Status::invalid_argument("client_seq 必须从 1 开始。"));
    }
    let mut state = state
        .lock()
        .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
    let Some(session) = state.get_session_mut(&frame.session_id) else {
        return Err(Status::not_found("session 不存在。"));
    };
    if session
        .response_cache_by_client_seq
        .contains_key(&frame.client_seq)
    {
        session.ack_client_seq(frame.client_seq);
        return Ok(None);
    }
    session.ack_client_seq(frame.client_seq);
    session.cache_insert(frame.client_seq, Vec::new());
    Ok(Some(TerminalFrameMeta {
        session_id: frame.session_id,
        request_id: frame.request_id,
        trace_id: frame.trace_id,
        client_seq: frame.client_seq,
    }))
}

async fn replay_cached_terminal_frames(
    state: &Arc<Mutex<AgentState>>,
    session_id: &str,
    client_seq: u64,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    let frames = {
        let mut state = state
            .lock()
            .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
        let Some(session) = state.get_session_mut(session_id) else {
            return Err(Status::not_found("session 不存在。"));
        };
        session
            .response_cache_by_client_seq
            .get(&client_seq)
            .cloned()
            .unwrap_or_default()
    };
    for frame in frames {
        if tx.send(Ok(frame)).await.is_err() {
            return Ok(());
        }
    }
    Ok(())
}

async fn send_terminal_event(
    state: &Arc<Mutex<AgentState>>,
    meta: &TerminalFrameMeta,
    payload: WslLinkTerminalServerPayload,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> Result<(), Status> {
    let frame = build_terminal_server_frame(state, meta, payload)?;
    tx.send(Ok(frame))
        .await
        .map_err(|_| Status::cancelled("WSL Link terminal duplex 已关闭。"))
}

fn build_terminal_server_frame(
    state: &Arc<Mutex<AgentState>>,
    meta: &TerminalFrameMeta,
    payload: WslLinkTerminalServerPayload,
) -> Result<ServerFrame, Status> {
    let mut state = state
        .lock()
        .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
    let Some(session) = state.get_session_mut(&meta.session_id) else {
        return Err(Status::not_found("session 不存在。"));
    };
    let server_seq = session.next_server_seq();
    let frame = ServerFrame {
        session_id: meta.session_id.clone(),
        request_id: meta.request_id.clone(),
        server_seq,
        ack_client_seq: session.ack_client_seq,
        payload: encode_terminal_server_payload(&payload)
            .map_err(|error| Status::internal(error.to_string()))?,
        trace_id: meta.trace_id.clone(),
    };
    session
        .response_cache_by_client_seq
        .entry(meta.client_seq)
        .or_default()
        .push(frame.clone());
    Ok(frame)
}

/// 用于 server-initiated 事件 (PTY reader / waiter 线程),不进入幂等缓存。
fn build_terminal_server_frame_uncached(
    state: &Arc<Mutex<AgentState>>,
    meta: &TerminalFrameMeta,
    request_id: impl Into<String>,
    payload: WslLinkTerminalServerPayload,
) -> Result<ServerFrame, Status> {
    let mut state = state
        .lock()
        .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
    let Some(session) = state.get_session_mut(&meta.session_id) else {
        return Err(Status::not_found("session 不存在。"));
    };
    let server_seq = session.next_server_seq();
    Ok(ServerFrame {
        session_id: meta.session_id.clone(),
        request_id: request_id.into(),
        server_seq,
        ack_client_seq: session.ack_client_seq,
        payload: encode_terminal_server_payload(&payload)
            .map_err(|error| Status::internal(error.to_string()))?,
        trace_id: meta.trace_id.clone(),
    })
}

fn send_terminal_event_uncached_blocking(
    state: &Arc<Mutex<AgentState>>,
    meta: &TerminalFrameMeta,
    request_id: impl Into<String>,
    payload: WslLinkTerminalServerPayload,
    tx: &tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) -> bool {
    let frame = match build_terminal_server_frame_uncached(state, meta, request_id, payload) {
        Ok(frame) => frame,
        Err(error) => return tx.blocking_send(Err(error)).is_ok(),
    };
    tx.blocking_send(Ok(frame)).is_ok()
}

fn get_interactive_pty(
    state: &Arc<Mutex<AgentState>>,
    wsl_link_session_id: &str,
    terminal_session_id: &str,
) -> Result<Arc<AgentInteractivePty>, Status> {
    let key = terminal_session_key(wsl_link_session_id, terminal_session_id);
    let state = state
        .lock()
        .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
    state
        .interactive_sessions
        .get(&key)
        .cloned()
        .ok_or_else(|| Status::not_found("交互终端 session 不存在。"))
}

fn register_terminal_run_input(
    state: &Arc<Mutex<AgentState>>,
    run_id: &str,
    input: tokio::sync::mpsc::UnboundedSender<String>,
) -> Result<(), Status> {
    let mut state = state
        .lock()
        .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
    state.active_run_inputs.insert(run_id.to_string(), input);
    Ok(())
}

fn get_terminal_run_input(
    state: &Arc<Mutex<AgentState>>,
    run_id: &str,
) -> Result<tokio::sync::mpsc::UnboundedSender<String>, Status> {
    let state = state
        .lock()
        .map_err(|_| Status::internal("WSL Link agent 状态锁已损坏。"))?;
    state
        .active_run_inputs
        .get(run_id)
        .cloned()
        .ok_or_else(|| Status::not_found("目标脚本运行不存在或已结束。"))
}

fn remove_terminal_run_input(state: &Arc<Mutex<AgentState>>, run_id: &str) {
    if let Ok(mut state) = state.lock() {
        state.active_run_inputs.remove(run_id);
    }
}

fn terminal_session_key(wsl_link_session_id: &str, terminal_session_id: &str) -> String {
    format!("{wsl_link_session_id}:{terminal_session_id}")
}

fn agent_pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.max(2),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_interactive_reader(
    state: Arc<Mutex<AgentState>>,
    meta: TerminalFrameMeta,
    terminal_session_id: String,
    mut reader: Box<dyn Read + Send>,
    tx: tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        let mut decoder = WslLinkUtf8ChunkDecoder::default();
        let mut output = String::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    output.clear();
                    decoder.decode_into(&buffer[..size], &mut output, false);
                    if output.is_empty() {
                        continue;
                    }
                    // 用 std::mem::take 避免每帧 clone 一次 String
                    let chunk = std::mem::take(&mut output);
                    let request_id = format!("interactive-data-{terminal_session_id}");
                    let sent = send_terminal_event_uncached_blocking(
                        &state,
                        &meta,
                        request_id,
                        WslLinkTerminalServerPayload::InteractiveData(
                            WslLinkTerminalInteractiveData {
                                session_id: terminal_session_id.clone(),
                                data: chunk,
                            },
                        ),
                        &tx,
                    );
                    if !sent {
                        break;
                    }
                }
                Err(error) => {
                    let _ = send_terminal_event_uncached_blocking(
                        &state,
                        &meta,
                        format!("interactive-error-{terminal_session_id}"),
                        WslLinkTerminalServerPayload::InteractiveError(
                            WslLinkTerminalInteractiveError {
                                session_id: Some(terminal_session_id.clone()),
                                message: format!("读取交互终端输出失败：{error}"),
                                exit_code: None,
                                finished_at_unix_ms: now_unix_ms_i64(),
                            },
                        ),
                        &tx,
                    );
                    break;
                }
            }
        }
        output.clear();
        decoder.decode_into(&[], &mut output, true);
        if !output.is_empty() {
            let _ = send_terminal_event_uncached_blocking(
                &state,
                &meta,
                format!("interactive-data-{terminal_session_id}"),
                WslLinkTerminalServerPayload::InteractiveData(WslLinkTerminalInteractiveData {
                    session_id: terminal_session_id,
                    data: output,
                }),
                &tx,
            );
        }
    });
}

fn spawn_interactive_waiter(
    state: &Arc<Mutex<AgentState>>,
    meta: TerminalFrameMeta,
    key: String,
    terminal_session_id: String,
    mut child: Box<dyn Child + Send + Sync>,
    pty: Arc<AgentInteractivePty>,
    tx: tokio::sync::mpsc::Sender<Result<ServerFrame, Status>>,
) {
    let state = Arc::clone(state);
    thread::spawn(move || {
        let exit_code = child
            .wait()
            .ok()
            .and_then(|status| i32::try_from(status.exit_code()).ok());
        pty.is_alive.store(false, Ordering::SeqCst);
        if let Ok(mut state_guard) = state.lock() {
            state_guard.interactive_sessions.remove(&key);
        }
        let _ = send_terminal_event_uncached_blocking(
            &state,
            &meta,
            format!("interactive-closed-{terminal_session_id}"),
            WslLinkTerminalServerPayload::InteractiveClosed(WslLinkTerminalInteractiveClosed {
                session_id: terminal_session_id,
                exit_code,
                finished_at_unix_ms: now_unix_ms_i64(),
            }),
            &tx,
        );
    });
}

enum TerminalProcessEvent {
    Chunk(String),
    Exit(Result<Option<i32>, String>),
}

async fn write_process_stdin<W>(
    run_id: String,
    mut stdin: W,
    mut input_rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    tx: tokio::sync::mpsc::Sender<TerminalProcessEvent>,
) where
    W: AsyncWrite + Unpin + Send + 'static,
{
    while let Some(input) = input_rx.recv().await {
        let result = match stdin.write_all(input.as_bytes()).await {
            Ok(()) => stdin.flush().await,
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            let _ = tx
                .send(TerminalProcessEvent::Chunk(format!(
                    "写入 WSL Link 脚本输入失败（{run_id}）：{error}\n"
                )))
                .await;
            break;
        }
    }
}

async fn read_process_stream<R>(mut reader: R, tx: tokio::sync::mpsc::Sender<TerminalProcessEvent>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 16 * 1024];
    let mut decoder = WslLinkUtf8ChunkDecoder::default();
    let mut output = String::new();
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(size) => {
                output.clear();
                decoder.decode_into(&buffer[..size], &mut output, false);
                if !output.is_empty() {
                    // 同样的小优化:take 而非 clone
                    let _ = tx
                        .send(TerminalProcessEvent::Chunk(std::mem::take(&mut output)))
                        .await;
                }
            }
            Err(error) => {
                let _ = tx
                    .send(TerminalProcessEvent::Chunk(format!(
                        "读取 WSL Link 脚本输出失败：{error}\n"
                    )))
                    .await;
                break;
            }
        }
    }
    output.clear();
    decoder.decode_into(&[], &mut output, true);
    if !output.is_empty() {
        let _ = tx.send(TerminalProcessEvent::Chunk(output)).await;
    }
}

async fn cleanup_terminal_run_files(paths: &[String]) {
    for path in paths.iter().filter(|path| path.starts_with("/tmp/")) {
        let _ = tokio::fs::remove_file(path).await;
    }
}

async fn set_private_file_permissions(path: &str) -> Result<(), Status> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        tokio::fs::set_permissions(path, permissions)
            .await
            .map_err(|error| {
                Status::internal(format!("设置 WSL Link 临时脚本权限失败：{error}"))
            })?;
    }
    // 非 Unix 平台:WSL agent 实际不会跑在这里,显式 no-op 而非 `let _ = path`
    #[cfg(not(unix))]
    {
        let _ = path; // suppress unused warning; agent is Linux-only
    }
    Ok(())
}

// now_unix_ms 不会超过 i64::MAX(到公元 2262 年),保留 saturation 仅作合约文档
fn now_unix_ms_i64() -> i64 {
    now_unix_ms().min(i64::MAX as u64) as i64
}

#[cfg(test)]
mod tests {
    use tonic::Request;

    use super::*;

    fn open_request() -> OpenSessionRequest {
        OpenSessionRequest {
            client_id: "desktop".to_string(),
            protocol_version: DEFAULT_PROTOCOL_VERSION.to_string(),
            last_client_seq: 2,
            trace_id: "trace-1".to_string(),
        }
    }

    #[tokio::test]
    async fn open_session_returns_vsock_transport_and_ack() {
        let service = WslLinkAgentService::new();
        let response = service
            .open_session(Request::new(open_request()))
            .await
            .expect("open session should work")
            .into_inner();
        assert_eq!(response.ack_client_seq, 2);
        assert_eq!(response.transport, TransportKind::VsockGrpc as i32);
        assert!(!response.session_id.is_empty());
    }

    #[tokio::test]
    async fn resume_unknown_session_is_rejected_without_error() {
        let service = WslLinkAgentService::new();
        let response = service
            .resume_session(Request::new(ResumeSessionRequest {
                session_id: "missing".to_string(),
                last_ack_server_seq: 0,
                last_client_seq: 3,
                trace_id: "trace-2".to_string(),
            }))
            .await
            .expect("resume should return structured response")
            .into_inner();
        assert!(!response.accepted);
    }

    #[tokio::test]
    async fn heartbeat_advances_server_seq_and_ack() {
        let service = WslLinkAgentService::new();
        let open = service
            .open_session(Request::new(open_request()))
            .await
            .expect("open session should work")
            .into_inner();
        let heartbeat = service
            .heartbeat(Request::new(HeartbeatRequest {
                session_id: open.session_id,
                client_seq: 7,
                ack_server_seq: 0,
                sent_at_unix_ms: 1,
            }))
            .await
            .expect("heartbeat should work")
            .into_inner();
        assert_eq!(heartbeat.ack_client_seq, 7);
        assert!(heartbeat.server_seq > open.server_seq);
    }

    #[test]
    fn duplicate_duplex_frame_with_same_seq_returns_cached_response() {
        let mut state = AgentState::default();
        let (session, _) = state.create_session(0);
        let frame = ClientFrame {
            session_id: session.session_id.clone(),
            request_id: "r1".to_string(),
            idempotency_key: "idem-1".to_string(),
            client_seq: 1,
            ack_server_seq: 0,
            payload: b"payload".to_vec(),
            trace_id: "trace-3".to_string(),
        };
        let first = build_server_frame(&mut state, frame.clone()).expect("first frame should work");
        let second = build_server_frame(&mut state, frame).expect("second frame should work");
        assert_eq!(first.payload, b"payload");
        assert_eq!(second.payload, b"payload");
        assert_eq!(second.server_seq, first.server_seq);
        assert_eq!(second.ack_client_seq, 1);
    }

    #[test]
    fn duplicate_duplex_frame_ignores_changed_idempotency_key_when_seq_matches() {
        let mut state = AgentState::default();
        let (session, _) = state.create_session(0);
        let mut frame = ClientFrame {
            session_id: session.session_id.clone(),
            request_id: "r1".to_string(),
            idempotency_key: "idem-1".to_string(),
            client_seq: 1,
            ack_server_seq: 0,
            payload: b"payload".to_vec(),
            trace_id: "trace-3".to_string(),
        };
        let first = build_server_frame(&mut state, frame.clone()).expect("first frame should work");
        frame.idempotency_key = "idem-2".to_string();
        frame.payload = b"changed".to_vec();
        let second = build_server_frame(&mut state, frame).expect("second frame should work");
        assert_eq!(second.server_seq, first.server_seq);
        assert_eq!(second.payload, b"payload");
    }
}