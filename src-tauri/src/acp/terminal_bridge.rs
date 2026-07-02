//! ACP terminal/* bridge.
//!
//! Runs agent-requested commands inside WSL2 through the same wsl.exe pipeline
//! the interactive terminal domain uses (default distro, login shell for
//! toolchain PATH parity), then exposes them via the ACP terminal methods:
//! create / output / wait_for_exit / kill / release. No native process path is
//! used, because this host only has a WSL2 toolchain.

use std::collections::HashMap;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use agent_client_protocol::Error;
use agent_client_protocol::schema::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, TerminalExitStatus, TerminalId,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};

use crate::terminal::wsl::{bash_quote, to_wsl_path};

/// Retained output cap when the agent does not specify one (1 MiB).
const DEFAULT_OUTPUT_BYTE_LIMIT: usize = 1024 * 1024;
/// Poll interval for reaping the child process.
const REAP_POLL: Duration = Duration::from_millis(50);
/// Read chunk size for the output pumps.
const READ_CHUNK: usize = 8192;

fn internal(msg: impl Into<String>) -> Error {
    Error::into_internal_error(std::io::Error::new(
        std::io::ErrorKind::Other,
        msg.into(),
    ))
}

/// Growing capture buffer with front truncation at a UTF-8 boundary, matching
/// the ACP contract for output_byte_limit.
struct OutputBuffer {
    data: Vec<u8>,
    truncated: bool,
    limit: usize,
}

impl OutputBuffer {
    fn push(&mut self, chunk: &[u8]) {
        self.data.extend_from_slice(chunk);
        if self.limit == 0 || self.data.len() <= self.limit {
            return;
        }
        let excess = self.data.len() - self.limit;
        self.data.drain(..excess);
        // Never split a multi-byte character: skip leading continuation bytes.
        let mut skip = 0;
        while skip < self.data.len() && (self.data[skip] & 0xC0) == 0x80 {
            skip += 1;
        }
        self.data.drain(..skip);
        self.truncated = true;
    }

    fn as_string(&self) -> String {
        String::from_utf8_lossy(&self.data).into_owned()
    }
}

/// Per-terminal shared state owned by the registry entry and its worker threads.
struct SharedState {
    output: Mutex<OutputBuffer>,
    exit: Mutex<Option<TerminalExitStatus>>,
    exit_cv: Condvar,
    child: Mutex<Option<Child>>,
}

fn spawn_reader<R: Read + Send + 'static>(mut reader: R, state: Arc<SharedState>) {
    thread::spawn(move || {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut out) = state.output.lock() {
                        out.push(&buf[..n]);
                    }
                }
            }
        }
    });
}

fn spawn_reaper(state: Arc<SharedState>) {
    thread::spawn(move || {
        loop {
            let status = {
                let mut guard = match state.child.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => Some(Ok(status)),
                        Ok(None) => None,
                        Err(err) => Some(Err(err)),
                    },
                    None => break,
                }
            };
            match status {
                Some(Ok(status)) => {
                    let exit = TerminalExitStatus::new()
                        .exit_code(status.code().map(|code| code as u32));
                    if let Ok(mut slot) = state.exit.lock() {
                        *slot = Some(exit);
                    }
                    state.exit_cv.notify_all();
                    break;
                }
                Some(Err(_)) => {
                    if let Ok(mut slot) = state.exit.lock() {
                        *slot = Some(TerminalExitStatus::new());
                    }
                    state.exit_cv.notify_all();
                    break;
                }
                None => thread::sleep(REAP_POLL),
            }
        }
    });
}

/// Registry of live ACP terminals. Cloneable handle over shared state.
#[derive(Clone)]
pub struct TerminalRegistry {
    inner: Arc<Mutex<HashMap<TerminalId, Arc<SharedState>>>>,
    next_id: Arc<AtomicU64>,
}

impl Default for TerminalRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    fn get(&self, id: &TerminalId) -> Result<Arc<SharedState>, Error> {
        self.inner
            .lock()
            .map_err(|_| internal("terminal registry poisoned"))?
            .get(id)
            .cloned()
            .ok_or_else(|| internal(format!("unknown terminal: {id}")))
    }

    /// Builds the bash program that reproduces the agent's command inside WSL:
    /// optional cwd, env exports, then exec of the (quoted) command + args.
    fn build_script(req: &CreateTerminalRequest) -> Result<String, Error> {
        let mut script = String::new();
        if let Some(cwd) = req.cwd.as_ref() {
            let wsl_dir = to_wsl_path(cwd).map_err(internal)?;
            script.push_str(&format!("cd {} && ", bash_quote(&wsl_dir)));
        }
        for var in &req.env {
            script.push_str(&format!("export {}={}; ", var.name, bash_quote(&var.value)));
        }
        script.push_str("exec ");
        script.push_str(&bash_quote(&req.command));
        for arg in &req.args {
            script.push(' ');
            script.push_str(&bash_quote(arg));
        }
        Ok(script)
    }

    pub fn create(&self, req: CreateTerminalRequest) -> Result<CreateTerminalResponse, Error> {
        let script = Self::build_script(&req)?;

        let mut command = Command::new("wsl.exe");
        command.arg("--").arg("bash").arg("-lc").arg(&script);
        command.env("WSL_UTF8", "1");
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        crate::commands::configure_std_command_for_background(&mut command);

        let mut child = command.spawn().map_err(Error::into_internal_error)?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let limit = req
            .output_byte_limit
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);

        let state = Arc::new(SharedState {
            output: Mutex::new(OutputBuffer {
                data: Vec::new(),
                truncated: false,
                limit,
            }),
            exit: Mutex::new(None),
            exit_cv: Condvar::new(),
            child: Mutex::new(Some(child)),
        });

        if let Some(stdout) = stdout {
            spawn_reader(stdout, state.clone());
        }
        if let Some(stderr) = stderr {
            spawn_reader(stderr, state.clone());
        }
        spawn_reaper(state.clone());

        let id = TerminalId::new(format!(
            "acp-term-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed)
        ));
        self.inner
            .lock()
            .map_err(|_| internal("terminal registry poisoned"))?
            .insert(id.clone(), state);

        Ok(CreateTerminalResponse::new(id))
    }

    pub fn output(&self, req: TerminalOutputRequest) -> Result<TerminalOutputResponse, Error> {
        let state = self.get(&req.terminal_id)?;
        let (text, truncated) = {
            let out = state
                .output
                .lock()
                .map_err(|_| internal("terminal output poisoned"))?;
            (out.as_string(), out.truncated)
        };
        let exit = state
            .exit
            .lock()
            .map_err(|_| internal("terminal exit poisoned"))?
            .clone();
        let mut resp = TerminalOutputResponse::new(text, truncated);
        if let Some(status) = exit {
            resp = resp.exit_status(status);
        }
        Ok(resp)
    }

    pub fn wait_for_exit(
        &self,
        req: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, Error> {
        let state = self.get(&req.terminal_id)?;
        let mut guard = state
            .exit
            .lock()
            .map_err(|_| internal("terminal exit poisoned"))?;
        while guard.is_none() {
            guard = state
                .exit_cv
                .wait(guard)
                .map_err(|_| internal("terminal exit wait poisoned"))?;
        }
        let status = guard.clone().unwrap_or_default();
        Ok(WaitForTerminalExitResponse::new(status))
    }

    pub fn kill(&self, req: KillTerminalRequest) -> Result<KillTerminalResponse, Error> {
        let state = self.get(&req.terminal_id)?;
        if let Ok(mut guard) = state.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
            }
        }
        Ok(KillTerminalResponse::new())
    }

    pub fn release(
        &self,
        req: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, Error> {
        let removed = self
            .inner
            .lock()
            .map_err(|_| internal("terminal registry poisoned"))?
            .remove(&req.terminal_id);
        if let Some(state) = removed {
            if let Ok(mut guard) = state.child.lock() {
                if let Some(child) = guard.as_mut() {
                    let _ = child.kill();
                }
            }
        }
        Ok(ReleaseTerminalResponse::new())
    }
}
