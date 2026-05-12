use std::{
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    time::Duration,
};

use thiserror::Error;
use tokio::{io::AsyncWriteExt, process::Command, time};

use super::{
    agent_install::AGENT_NOISE_CONFIG_FILE_NAME,
    noise_material::{
        encode_agent_material, generate_pairing_material, WslLinkDesktopNoiseMaterial,
        WslLinkNoiseMaterialError, WslLinkNoiseMaterialStore,
    },
};

pub const WSL_EXE_PROGRAM: &str = "wsl.exe";
pub const AGENT_BINARY_ENV: &str = "CALAMEX_WSL_LINK_AGENT_BINARY";
pub const PACKAGED_AGENT_RESOURCE_PATH: &str =
    "binaries/wsl-link/wsl-link-agent-x86_64-unknown-linux-gnu";
pub const DEV_AGENT_ARTIFACT_PATH: &str =
    "src-tauri/binaries/wsl-link/wsl-link-agent-x86_64-unknown-linux-gnu";
pub const USER_AGENT_INSTALL_DIR: &str = "${HOME}/.local/share/calamex/wsl-link";
pub const USER_AGENT_CONFIG_DIR: &str = "${HOME}/.config/calamex/wsl-link";
pub const AGENT_BINARY_FILE_NAME: &str = "wsl-link-agent";
pub const AGENT_PID_FILE_NAME: &str = "agent.pid";
pub const AGENT_LOG_FILE_NAME: &str = "agent.log";
pub const DEFAULT_DISTRIBUTION_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WslLinkDistroTarget {
    Default,
    Named(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WslLinkDistributionPayload {
    AgentBinary,
    NoiseConfig,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkWslCommandSpec {
    pub program: &'static str,
    pub args: Vec<String>,
    pub stdin_payload: Option<WslLinkDistributionPayload>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkDistributionCommandOutput {
    pub status_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WslLinkAgentDistributionStepKind {
    PrepareDirectories,
    WriteAgentBinary,
    WriteNoiseConfig,
    VerifyInstall,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkAgentDistributionStep {
    pub kind: WslLinkAgentDistributionStepKind,
    pub command: WslLinkWslCommandSpec,
    pub payload: Option<Vec<u8>>,
}

#[derive(Debug, Clone)]
pub struct WslLinkAgentDistributionBundle {
    pub plan: WslLinkAgentDistributionPlan,
    pub desktop_material: WslLinkDesktopNoiseMaterial,
    pub steps: Vec<WslLinkAgentDistributionStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkAgentDistributionOutcome {
    pub binary_path: String,
    pub noise_config_path: String,
    pub outputs: Vec<WslLinkDistributionCommandOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkAgentStartOutcome {
    pub binary_path: String,
    pub noise_config_path: String,
    pub pid_path: String,
    pub log_path: String,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkAgentArtifactReport {
    pub found: bool,
    pub path: Option<PathBuf>,
    pub candidates: Vec<PathBuf>,
    pub message: String,
}

pub trait WslLinkDistributionCommandRunner {
    fn run<'a>(
        &'a self,
        spec: &'a WslLinkWslCommandSpec,
        payload: Option<&'a [u8]>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        WslLinkDistributionCommandOutput,
                        WslLinkAgentDistributionError,
                    >,
                > + Send
                + 'a,
        >,
    >;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct RealWslLinkDistributionCommandRunner;

impl WslLinkDistributionCommandRunner for RealWslLinkDistributionCommandRunner {
    fn run<'a>(
        &'a self,
        spec: &'a WslLinkWslCommandSpec,
        payload: Option<&'a [u8]>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        WslLinkDistributionCommandOutput,
                        WslLinkAgentDistributionError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(run_distribution_command(spec, payload))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslLinkAgentDistributionPlan {
    pub distro: WslLinkDistroTarget,
    pub install_dir: String,
    pub config_dir: String,
    pub binary_path: String,
    pub noise_config_path: String,
    pub pid_path: String,
    pub log_path: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WslLinkAgentDistributionError {
    #[error("WSL 发行版名称不能为空。")]
    EmptyDistroName,
    #[error("WSL 发行版名称包含不支持的控制字符。")]
    InvalidDistroName,
    #[error("WSL agent 路径不能为空。")]
    EmptyPath,
    #[error("WSL agent 路径必须使用绝对路径、~ 或 ${{HOME}} 前缀：{0}")]
    UnsupportedPath(String),
    #[error("WSL agent 路径包含不支持的 NUL 字符。")]
    InvalidPath,
    #[error("WSL agent binary payload 不能为空。")]
    EmptyAgentBinary,
    #[error("WSL Link agent Noise 配对材料生成失败：{0}")]
    NoiseMaterial(String),
    #[error("未找到 WSL Link Linux agent 构建产物。请设置 CALAMEX_WSL_LINK_AGENT_BINARY 或随应用分发 wsl_link_agent。")]
    AgentArtifactNotFound,
    #[error("WSL Link Linux agent 构建产物路径不可用：{0}")]
    AgentArtifactPath(String),
    #[error("读取 WSL Link Linux agent 构建产物失败：{0}")]
    AgentArtifactRead(String),
    #[error("WSL agent 分发命令需要 stdin payload：{0:?}")]
    MissingPayload(WslLinkDistributionPayload),
    #[error("WSL agent 分发命令不接受 stdin payload。")]
    UnexpectedPayload,
    #[error("WSL agent 分发命令启动失败：{0}")]
    Spawn(String),
    #[error("WSL agent 分发命令 stdin 不可用。")]
    StdinUnavailable,
    #[error("写入 WSL agent 分发 payload 失败：{0}")]
    WriteStdin(String),
    #[error("WSL agent 分发命令超时：{0:?}")]
    Timeout(Duration),
    #[error("WSL agent 分发命令执行失败，退出码：{status_code:?}，stderr：{stderr}")]
    CommandFailed {
        status_code: Option<i32>,
        stderr: String,
    },
}

impl From<WslLinkNoiseMaterialError> for WslLinkAgentDistributionError {
    fn from(error: WslLinkNoiseMaterialError) -> Self {
        Self::NoiseMaterial(error.to_string())
    }
}

impl WslLinkDistroTarget {
    pub fn named(value: impl Into<String>) -> Result<Self, WslLinkAgentDistributionError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(WslLinkAgentDistributionError::EmptyDistroName);
        }
        if trimmed
            .chars()
            .any(|ch| ch == '\0' || ch == '\n' || ch == '\r')
        {
            return Err(WslLinkAgentDistributionError::InvalidDistroName);
        }
        Ok(Self::Named(trimmed.to_string()))
    }
}

impl WslLinkAgentDistributionPlan {
    pub fn user_default() -> Self {
        Self::for_user_paths(
            WslLinkDistroTarget::Default,
            USER_AGENT_INSTALL_DIR,
            USER_AGENT_CONFIG_DIR,
        )
        .expect("内置 WSL Link agent 用户路径必须有效")
    }

    pub fn for_user_paths(
        distro: WslLinkDistroTarget,
        install_dir: impl Into<String>,
        config_dir: impl Into<String>,
    ) -> Result<Self, WslLinkAgentDistributionError> {
        let install_dir = normalize_linux_path(install_dir.into())?;
        let config_dir = normalize_linux_path(config_dir.into())?;
        let binary_path = join_linux_path(&install_dir, AGENT_BINARY_FILE_NAME);
        let noise_config_path = join_linux_path(&config_dir, AGENT_NOISE_CONFIG_FILE_NAME);
        let pid_path = join_linux_path(&install_dir, AGENT_PID_FILE_NAME);
        let log_path = join_linux_path(&install_dir, AGENT_LOG_FILE_NAME);

        Ok(Self {
            distro,
            install_dir,
            config_dir,
            binary_path,
            noise_config_path,
            pid_path,
            log_path,
        })
    }

    pub fn prepare_command(&self) -> WslLinkWslCommandSpec {
        let install_dir = sh_path_expr(&self.install_dir);
        let config_dir = sh_path_expr(&self.config_dir);
        self.shell_command(format!(
            "set -eu\n\
             umask 077\n\
             mkdir -p {install_dir} {config_dir}\n\
             chmod 700 {install_dir} {config_dir}"
        ))
    }

    pub fn write_agent_binary_command(&self) -> WslLinkWslCommandSpec {
        self.write_file_command(
            &self.binary_path,
            "700",
            WslLinkDistributionPayload::AgentBinary,
        )
    }

    pub fn write_noise_config_command(&self) -> WslLinkWslCommandSpec {
        self.write_file_command(
            &self.noise_config_path,
            "600",
            WslLinkDistributionPayload::NoiseConfig,
        )
    }

    pub fn verify_command(&self) -> WslLinkWslCommandSpec {
        let binary_path = sh_path_expr(&self.binary_path);
        let noise_config_path = sh_path_expr(&self.noise_config_path);
        self.shell_command(format!(
            "set -eu\n\
             test -x {binary_path}\n\
             test -r {noise_config_path}\n\
             {binary_path} --help >/dev/null"
        ))
    }

    pub fn start_command(&self) -> WslLinkWslCommandSpec {
        let binary_path = sh_path_expr(&self.binary_path);
        let noise_config_path = sh_path_expr(&self.noise_config_path);
        let pid_path = sh_path_expr(&self.pid_path);
        let log_path = sh_path_expr(&self.log_path);
        let install_dir = sh_path_expr(&self.install_dir);
        self.shell_command(format!(
            "set -eu\n\
             binary={binary_path}\n\
             config={noise_config_path}\n\
             pid_file={pid_path}\n\
             log_file={log_path}\n\
             test -x \"$binary\"\n\
             test -r \"$config\"\n\
             mkdir -p {install_dir}\n\
             chmod 700 {install_dir}\n\
             stop_agent_pid() {{\n\
               target_pid=\"$1\"\n\
               if [ -z \"$target_pid\" ] || [ \"$target_pid\" = \"$$\" ]; then\n\
                 return 0\n\
               fi\n\
               if kill -0 \"$target_pid\" 2>/dev/null; then\n\
                 kill \"$target_pid\" 2>/dev/null || true\n\
                 j=0\n\
                 while [ \"$j\" -lt 20 ] && kill -0 \"$target_pid\" 2>/dev/null; do\n\
                   j=$((j + 1))\n\
                   sleep 0.1\n\
                 done\n\
                 if kill -0 \"$target_pid\" 2>/dev/null; then\n\
                   kill -KILL \"$target_pid\" 2>/dev/null || true\n\
                 fi\n\
               fi\n\
             }}\n\
             if [ -f \"$pid_file\" ]; then\n\
               old_pid=$(cat \"$pid_file\" 2>/dev/null || true)\n\
               stop_agent_pid \"$old_pid\"\n\
             fi\n\
             if command -v pgrep >/dev/null 2>&1; then\n\
               for old_pid in $(pgrep -f \"$binary --noise-config $config\" 2>/dev/null || true); do\n\
                 stop_agent_pid \"$old_pid\"\n\
               done\n\
             fi\n\
             rm -f \"$pid_file\"\n\
             nohup \"$binary\" --noise-config \"$config\" </dev/null >>\"$log_file\" 2>&1 &\n\
             pid=$!\n\
             printf '%s\\n' \"$pid\" >\"$pid_file\"\n\
             chmod 600 \"$pid_file\"\n\
             i=0\n\
             while [ \"$i\" -lt 10 ]; do\n\
               if ! kill -0 \"$pid\" 2>/dev/null; then\n\
                 tail -n 40 \"$log_file\" >&2 || true\n\
                 rm -f \"$pid_file\"\n\
                 exit 1\n\
               fi\n\
               i=$((i + 1))\n\
               sleep 0.1\n\
             done\n\
             printf 'started pid=%s\\n' \"$pid\""
        ))
    }

    fn write_file_command(
        &self,
        target_path: &str,
        mode: &'static str,
        payload: WslLinkDistributionPayload,
    ) -> WslLinkWslCommandSpec {
        let target = sh_path_expr(target_path);
        let parent = sh_path_expr(parent_linux_path(target_path));
        let script = format!(
            "set -eu\n\
             umask 077\n\
             mkdir -p {parent}\n\
             chmod 700 {parent}\n\
             tmp={target}.tmp.$$\n\
             trap 'rm -f \"$tmp\"' EXIT HUP INT TERM\n\
             cat > \"$tmp\"\n\
             chmod {mode} \"$tmp\"\n\
             mv -f \"$tmp\" {target}\n\
             chmod {mode} {target}\n\
             trap - EXIT",
        );
        let mut command = self.shell_command(script);
        command.stdin_payload = Some(payload);
        command
    }

    fn shell_command(&self, script: String) -> WslLinkWslCommandSpec {
        let mut args = match &self.distro {
            WslLinkDistroTarget::Default => Vec::new(),
            WslLinkDistroTarget::Named(name) => {
                vec!["--distribution".to_string(), name.clone()]
            }
        };
        args.extend([
            "--".to_string(),
            "sh".to_string(),
            "-lc".to_string(),
            script,
        ]);

        WslLinkWslCommandSpec {
            program: WSL_EXE_PROGRAM,
            args,
            stdin_payload: None,
        }
    }
}

pub fn build_agent_distribution_bundle(
    plan: WslLinkAgentDistributionPlan,
    agent_binary: Vec<u8>,
) -> Result<WslLinkAgentDistributionBundle, WslLinkAgentDistributionError> {
    if agent_binary.is_empty() {
        return Err(WslLinkAgentDistributionError::EmptyAgentBinary);
    }

    let pairing = generate_pairing_material()?;
    let agent_noise_config = encode_agent_material(&pairing.agent)?.into_bytes();
    let steps = vec![
        WslLinkAgentDistributionStep {
            kind: WslLinkAgentDistributionStepKind::PrepareDirectories,
            command: plan.prepare_command(),
            payload: None,
        },
        WslLinkAgentDistributionStep {
            kind: WslLinkAgentDistributionStepKind::WriteAgentBinary,
            command: plan.write_agent_binary_command(),
            payload: Some(agent_binary),
        },
        WslLinkAgentDistributionStep {
            kind: WslLinkAgentDistributionStepKind::WriteNoiseConfig,
            command: plan.write_noise_config_command(),
            payload: Some(agent_noise_config),
        },
        WslLinkAgentDistributionStep {
            kind: WslLinkAgentDistributionStepKind::VerifyInstall,
            command: plan.verify_command(),
            payload: None,
        },
    ];

    Ok(WslLinkAgentDistributionBundle {
        plan,
        desktop_material: pairing.desktop,
        steps,
    })
}

pub async fn install_agent_distribution_bundle<S>(
    bundle: &WslLinkAgentDistributionBundle,
    store: &S,
) -> Result<WslLinkAgentDistributionOutcome, WslLinkAgentDistributionError>
where
    S: WslLinkNoiseMaterialStore,
{
    install_agent_distribution_bundle_with_runner(
        bundle,
        store,
        &RealWslLinkDistributionCommandRunner,
    )
    .await
}

pub async fn install_agent_distribution_bundle_with_runner<S, R>(
    bundle: &WslLinkAgentDistributionBundle,
    store: &S,
    runner: &R,
) -> Result<WslLinkAgentDistributionOutcome, WslLinkAgentDistributionError>
where
    S: WslLinkNoiseMaterialStore,
    R: WslLinkDistributionCommandRunner,
{
    let mut outputs = Vec::with_capacity(bundle.steps.len());
    for step in &bundle.steps {
        outputs.push(runner.run(&step.command, step.payload.as_deref()).await?);
    }

    store.save_desktop_material(&bundle.desktop_material)?;
    Ok(WslLinkAgentDistributionOutcome {
        binary_path: bundle.plan.binary_path.clone(),
        noise_config_path: bundle.plan.noise_config_path.clone(),
        outputs,
    })
}

pub async fn start_installed_agent(
    plan: &WslLinkAgentDistributionPlan,
) -> Result<WslLinkAgentStartOutcome, WslLinkAgentDistributionError> {
    start_installed_agent_with_runner(plan, &RealWslLinkDistributionCommandRunner).await
}

pub async fn start_installed_agent_with_runner<R>(
    plan: &WslLinkAgentDistributionPlan,
    runner: &R,
) -> Result<WslLinkAgentStartOutcome, WslLinkAgentDistributionError>
where
    R: WslLinkDistributionCommandRunner,
{
    let output = runner.run(&plan.start_command(), None).await?;
    Ok(WslLinkAgentStartOutcome {
        binary_path: plan.binary_path.clone(),
        noise_config_path: plan.noise_config_path.clone(),
        pid_path: plan.pid_path.clone(),
        log_path: plan.log_path.clone(),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

pub fn resolve_agent_binary_bytes() -> Result<Vec<u8>, WslLinkAgentDistributionError> {
    resolve_agent_binary_bytes_with_extra_candidates(std::iter::empty::<PathBuf>())
}

pub fn resolve_agent_binary_bytes_with_extra_candidates<I>(
    extra_candidates: I,
) -> Result<Vec<u8>, WslLinkAgentDistributionError>
where
    I: IntoIterator<Item = PathBuf>,
{
    let path = resolve_agent_binary_path_with_extra_candidates(extra_candidates)?;
    let bytes = fs::read(&path)
        .map_err(|error| WslLinkAgentDistributionError::AgentArtifactRead(error.to_string()))?;
    if bytes.is_empty() {
        return Err(WslLinkAgentDistributionError::EmptyAgentBinary);
    }
    Ok(bytes)
}

pub fn resolve_agent_binary_path() -> Result<PathBuf, WslLinkAgentDistributionError> {
    resolve_agent_binary_path_with_extra_candidates(std::iter::empty::<PathBuf>())
}

pub fn resolve_agent_binary_path_with_extra_candidates<I>(
    extra_candidates: I,
) -> Result<PathBuf, WslLinkAgentDistributionError>
where
    I: IntoIterator<Item = PathBuf>,
{
    if let Some(path) = env::var_os(AGENT_BINARY_ENV).filter(|value| !value.is_empty()) {
        return require_agent_binary_file(PathBuf::from(path));
    }

    for path in agent_binary_candidates(extra_candidates)? {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(WslLinkAgentDistributionError::AgentArtifactNotFound)
}

pub fn agent_binary_artifact_report<I>(
    extra_candidates: I,
) -> Result<WslLinkAgentArtifactReport, WslLinkAgentDistributionError>
where
    I: IntoIterator<Item = PathBuf>,
{
    let candidates = agent_binary_candidates(extra_candidates)?;

    if let Some(path) = env::var_os(AGENT_BINARY_ENV).filter(|value| !value.is_empty()) {
        let path = normalize_host_path(&PathBuf::from(path))?;
        return Ok(if path.is_file() {
            WslLinkAgentArtifactReport {
                found: true,
                path: Some(path.clone()),
                candidates,
                message: format!(
                    "已通过 {} 找到 WSL Link Linux agent 构建产物。",
                    AGENT_BINARY_ENV
                ),
            }
        } else {
            WslLinkAgentArtifactReport {
                found: false,
                path: None,
                candidates: prepend_candidate(path.clone(), candidates),
                message: format!(
                    "{} 指向的 WSL Link Linux agent 构建产物不可用：{}",
                    AGENT_BINARY_ENV,
                    path.display()
                ),
            }
        });
    }

    let found = candidates.iter().find(|path| path.is_file()).cloned();
    Ok(match found {
        Some(path) => WslLinkAgentArtifactReport {
            found: true,
            path: Some(path),
            candidates,
            message: "已找到 WSL Link Linux agent 构建产物。".to_string(),
        },
        None => WslLinkAgentArtifactReport {
            found: false,
            path: None,
            candidates,
            message: format!(
                "未找到 WSL Link Linux agent 构建产物。请运行 pnpm wsl-link:agent:build，或设置 {}。",
                AGENT_BINARY_ENV
            ),
        },
    })
}

pub fn agent_binary_candidates<I>(
    extra_candidates: I,
) -> Result<Vec<PathBuf>, WslLinkAgentDistributionError>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut candidates = Vec::new();
    candidates.extend(extra_candidates);
    candidates.extend(default_agent_binary_candidates()?);
    Ok(dedupe_paths(candidates))
}

fn default_agent_binary_candidates() -> Result<Vec<PathBuf>, WslLinkAgentDistributionError> {
    let exe = env::current_exe()
        .map_err(|error| WslLinkAgentDistributionError::AgentArtifactPath(error.to_string()))?;
    let Some(dir) = exe.parent() else {
        return Err(WslLinkAgentDistributionError::AgentArtifactNotFound);
    };

    let mut candidates = vec![
        dir.join("wsl_link_agent"),
        dir.join("wsl-link-agent"),
        dir.join("wsl-link").join("wsl_link_agent"),
        dir.join("wsl-link").join("wsl-link-agent"),
        dir.join(PACKAGED_AGENT_RESOURCE_PATH),
    ];

    candidates.extend(workspace_agent_artifact_candidates(&exe));
    Ok(dedupe_paths(candidates))
}

fn workspace_agent_artifact_candidates(exe: &Path) -> Vec<PathBuf> {
    exe.ancestors()
        .flat_map(|ancestor| {
            [
                ancestor.join(DEV_AGENT_ARTIFACT_PATH),
                ancestor.join("binaries/wsl-link/wsl-link-agent-x86_64-unknown-linux-gnu"),
                ancestor.join("target/x86_64-unknown-linux-gnu/release/wsl_link_agent"),
                ancestor.join("target/x86_64-unknown-linux-gnu/debug/wsl_link_agent"),
            ]
        })
        .collect()
}

fn prepend_candidate(path: PathBuf, candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut merged = Vec::with_capacity(candidates.len() + 1);
    merged.push(path);
    merged.extend(candidates);
    dedupe_paths(merged)
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    paths
        .into_iter()
        .filter(|path| seen.insert(path.to_string_lossy().to_string()))
        .collect()
}

fn require_agent_binary_file(path: PathBuf) -> Result<PathBuf, WslLinkAgentDistributionError> {
    let path = normalize_host_path(&path)?;
    if path.is_file() {
        Ok(path)
    } else {
        Err(WslLinkAgentDistributionError::AgentArtifactPath(
            path.display().to_string(),
        ))
    }
}

fn normalize_host_path(path: &Path) -> Result<PathBuf, WslLinkAgentDistributionError> {
    if path.as_os_str().is_empty() {
        return Err(WslLinkAgentDistributionError::AgentArtifactPath(
            "路径不能为空。".to_string(),
        ));
    }
    Ok(path.to_path_buf())
}

pub async fn run_distribution_command(
    spec: &WslLinkWslCommandSpec,
    payload: Option<&[u8]>,
) -> Result<WslLinkDistributionCommandOutput, WslLinkAgentDistributionError> {
    run_distribution_command_with_timeout(spec, payload, DEFAULT_DISTRIBUTION_COMMAND_TIMEOUT).await
}

pub async fn run_distribution_command_with_timeout(
    spec: &WslLinkWslCommandSpec,
    payload: Option<&[u8]>,
    timeout: Duration,
) -> Result<WslLinkDistributionCommandOutput, WslLinkAgentDistributionError> {
    match (spec.stdin_payload, payload) {
        (Some(expected), None) => {
            return Err(WslLinkAgentDistributionError::MissingPayload(expected));
        }
        (None, Some(_)) => return Err(WslLinkAgentDistributionError::UnexpectedPayload),
        _ => {}
    }

    let mut command = Command::new(spec.program);
    command
        .args(&spec.args)
        .kill_on_drop(true)
        .stdin(if payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_command_for_background(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| WslLinkAgentDistributionError::Spawn(error.to_string()))?;

    if let Some(payload) = payload {
        let mut stdin = child
            .stdin
            .take()
            .ok_or(WslLinkAgentDistributionError::StdinUnavailable)?;
        stdin
            .write_all(payload)
            .await
            .map_err(|error| WslLinkAgentDistributionError::WriteStdin(error.to_string()))?;
        stdin
            .shutdown()
            .await
            .map_err(|error| WslLinkAgentDistributionError::WriteStdin(error.to_string()))?;
    }

    let output = match time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => {
            result.map_err(|error| WslLinkAgentDistributionError::Spawn(error.to_string()))?
        }
        Err(_) => return Err(WslLinkAgentDistributionError::Timeout(timeout)),
    };

    let output = WslLinkDistributionCommandOutput {
        status_code: output.status.code(),
        stdout: decode_command_output(&output.stdout),
        stderr: decode_command_output(&output.stderr),
    };

    if output.status_code == Some(0) {
        Ok(output)
    } else {
        Err(WslLinkAgentDistributionError::CommandFailed {
            status_code: output.status_code,
            stderr: output.stderr,
        })
    }
}

#[cfg(windows)]
fn configure_command_for_background(command: &mut Command) {
    command.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
fn configure_command_for_background(_command: &mut Command) {}

fn normalize_linux_path(value: String) -> Result<String, WslLinkAgentDistributionError> {
    let path = value.trim();
    if path.is_empty() {
        return Err(WslLinkAgentDistributionError::EmptyPath);
    }
    if path.contains('\0') {
        return Err(WslLinkAgentDistributionError::InvalidPath);
    }
    if !(path.starts_with('/') || path.starts_with("~/") || path.starts_with("${HOME}/")) {
        return Err(WslLinkAgentDistributionError::UnsupportedPath(
            path.to_string(),
        ));
    }
    Ok(path.trim_end_matches('/').to_string())
}

fn join_linux_path(parent: &str, file_name: &str) -> String {
    format!("{}/{}", parent.trim_end_matches('/'), file_name)
}

fn parent_linux_path(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(parent, _)| parent)
        .filter(|parent| !parent.is_empty())
        .unwrap_or("/")
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn sh_path_expr(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("${HOME}/") {
        return format!("\"$HOME/{}\"", sh_double_quote_body(rest));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return format!("\"$HOME/{}\"", sh_double_quote_body(rest));
    }
    sh_quote(value)
}

fn sh_double_quote_body(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
}

fn decode_command_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    struct TestNoiseMaterialStore {
        saved: Arc<Mutex<bool>>,
    }

    impl super::WslLinkNoiseMaterialStore for TestNoiseMaterialStore {
        fn load_desktop_material(
            &self,
        ) -> Result<
            Option<crate::wsl_link::noise_material::WslLinkDesktopNoiseMaterial>,
            crate::wsl_link::noise_material::WslLinkNoiseMaterialError,
        > {
            Ok(None)
        }

        fn save_desktop_material(
            &self,
            _material: &crate::wsl_link::noise_material::WslLinkDesktopNoiseMaterial,
        ) -> Result<(), crate::wsl_link::noise_material::WslLinkNoiseMaterialError> {
            *self.saved.lock().expect("test store lock should work") = true;
            Ok(())
        }

        fn delete_desktop_material(
            &self,
        ) -> Result<(), crate::wsl_link::noise_material::WslLinkNoiseMaterialError> {
            *self.saved.lock().expect("test store lock should work") = false;
            Ok(())
        }
    }

    struct TestDistributionRunner {
        seen: Arc<Mutex<Vec<WslLinkAgentDistributionStepKind>>>,
        fail_at: Option<usize>,
    }

    impl WslLinkDistributionCommandRunner for TestDistributionRunner {
        fn run<'a>(
            &'a self,
            spec: &'a WslLinkWslCommandSpec,
            _payload: Option<&'a [u8]>,
        ) -> Pin<
            Box<
                dyn Future<
                        Output = Result<
                            WslLinkDistributionCommandOutput,
                            WslLinkAgentDistributionError,
                        >,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                let index = {
                    let mut seen = self.seen.lock().expect("test runner lock should work");
                    let kind = infer_step_kind_for_test(spec);
                    seen.push(kind);
                    seen.len() - 1
                };
                if self.fail_at == Some(index) {
                    return Err(WslLinkAgentDistributionError::CommandFailed {
                        status_code: Some(1),
                        stderr: "boom".to_string(),
                    });
                }
                Ok(WslLinkDistributionCommandOutput {
                    status_code: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                })
            })
        }
    }

    fn infer_step_kind_for_test(spec: &WslLinkWslCommandSpec) -> WslLinkAgentDistributionStepKind {
        let script = spec.args.last().map(String::as_str).unwrap_or_default();
        if spec.stdin_payload == Some(WslLinkDistributionPayload::AgentBinary) {
            WslLinkAgentDistributionStepKind::WriteAgentBinary
        } else if spec.stdin_payload == Some(WslLinkDistributionPayload::NoiseConfig) {
            WslLinkAgentDistributionStepKind::WriteNoiseConfig
        } else if script.contains("--help >/dev/null") {
            WslLinkAgentDistributionStepKind::VerifyInstall
        } else {
            WslLinkAgentDistributionStepKind::PrepareDirectories
        }
    }

    fn temp_agent_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "calamex-wsl-link-agent-distribution-{name}-{}-{}",
            std::process::id(),
            crate::wsl_link::types::now_unix_ms()
        ));
        std::fs::create_dir_all(&dir).expect("test dir should create");
        let path = dir.join("wsl-link-agent");
        std::fs::write(&path, b"agent-binary").expect("test agent should write");
        path
    }

    #[test]
    fn default_plan_uses_user_scoped_paths() {
        let plan = WslLinkAgentDistributionPlan::user_default();

        assert_eq!(plan.install_dir, USER_AGENT_INSTALL_DIR);
        assert_eq!(plan.config_dir, USER_AGENT_CONFIG_DIR);
        assert_eq!(
            plan.binary_path,
            "${HOME}/.local/share/calamex/wsl-link/wsl-link-agent"
        );
        assert_eq!(
            plan.noise_config_path,
            "${HOME}/.config/calamex/wsl-link/agent-noise.json"
        );
        assert_eq!(
            plan.pid_path,
            "${HOME}/.local/share/calamex/wsl-link/agent.pid"
        );
        assert_eq!(
            plan.log_path,
            "${HOME}/.local/share/calamex/wsl-link/agent.log"
        );
    }

    #[test]
    fn named_distro_is_passed_as_single_wsl_argument() {
        let distro = WslLinkDistroTarget::named("Ubuntu 中文 24.04").expect("distro should parse");
        let plan = WslLinkAgentDistributionPlan::for_user_paths(
            distro,
            USER_AGENT_INSTALL_DIR,
            USER_AGENT_CONFIG_DIR,
        )
        .expect("plan should build");
        let command = plan.prepare_command();

        assert_eq!(command.program, WSL_EXE_PROGRAM);
        assert_eq!(command.args[0], "--distribution");
        assert_eq!(command.args[1], "Ubuntu 中文 24.04");
        assert_eq!(command.args[2], "--");
    }

    #[test]
    fn named_distro_rejects_line_breaks() {
        let result = WslLinkDistroTarget::named("Ubuntu\n24.04");

        assert_eq!(
            result,
            Err(WslLinkAgentDistributionError::InvalidDistroName)
        );
    }

    #[test]
    fn write_agent_binary_command_uses_stdin_payload_and_executable_mode() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let command = plan.write_agent_binary_command();
        let script = command.args.last().expect("script should exist");

        assert_eq!(
            command.stdin_payload,
            Some(WslLinkDistributionPayload::AgentBinary)
        );
        assert!(script.contains("chmod 700 \"$tmp\""));
        assert!(script.contains("wsl-link-agent"));
    }

    #[test]
    fn write_noise_config_command_uses_secret_mode() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let command = plan.write_noise_config_command();
        let script = command.args.last().expect("script should exist");

        assert_eq!(
            command.stdin_payload,
            Some(WslLinkDistributionPayload::NoiseConfig)
        );
        assert!(script.contains("chmod 600 \"$tmp\""));
        assert!(script.contains("agent-noise.json"));
    }

    #[test]
    fn start_command_runs_agent_in_background_and_verifies_pid() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let command = plan.start_command();
        let script = command.args.last().expect("script should exist");

        assert_eq!(command.stdin_payload, None);
        assert!(script.contains("nohup \"$binary\" --noise-config \"$config\""));
        assert!(script.contains("agent.pid"));
        assert!(script.contains("kill -0 \"$pid\""));
        assert!(script.contains("tail -n 40 \"$log_file\""));
    }

    #[test]
    fn custom_path_rejects_relative_path() {
        let result = WslLinkAgentDistributionPlan::for_user_paths(
            WslLinkDistroTarget::Default,
            "relative/path",
            USER_AGENT_CONFIG_DIR,
        );

        assert!(matches!(
            result,
            Err(WslLinkAgentDistributionError::UnsupportedPath(_))
        ));
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(sh_quote("/tmp/a'b"), "'/tmp/a'\"'\"'b'");
    }

    #[test]
    fn home_path_expr_expands_in_wsl_shell_command() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let command = plan.prepare_command();
        let script = command.args.last().expect("script should exist");

        assert!(script.contains("\"$HOME/.local/share/calamex/wsl-link\""));
        assert!(!script.contains("'${HOME}/"));
        assert!(!script.contains("\\$HOME"));
    }

    #[test]
    fn distribution_bundle_rejects_empty_agent_binary() {
        let result =
            build_agent_distribution_bundle(WslLinkAgentDistributionPlan::user_default(), vec![]);

        assert!(matches!(
            result,
            Err(WslLinkAgentDistributionError::EmptyAgentBinary)
        ));
    }

    #[test]
    fn artifact_report_finds_extra_candidate() {
        let path = temp_agent_file("extra-candidate");

        let report = agent_binary_artifact_report([path.clone()]).expect("report should build");

        assert!(report.found);
        assert_eq!(report.path, Some(path.clone()));
        assert_eq!(report.candidates.first(), Some(&path));

        let _ = std::fs::remove_dir_all(path.parent().expect("path has parent"));
    }

    #[test]
    fn artifact_candidates_are_deduplicated() {
        let path = std::path::PathBuf::from("agent-candidate");

        let candidates =
            agent_binary_candidates([path.clone(), path.clone()]).expect("candidates should build");
        let count = candidates
            .iter()
            .filter(|candidate| **candidate == path)
            .count();

        assert_eq!(count, 1);
    }

    #[test]
    fn distribution_bundle_builds_ordered_steps_and_payloads() {
        let bundle = build_agent_distribution_bundle(
            WslLinkAgentDistributionPlan::user_default(),
            b"agent-binary".to_vec(),
        )
        .expect("bundle should build");

        let step_kinds = bundle
            .steps
            .iter()
            .map(|step| step.kind)
            .collect::<Vec<_>>();
        assert_eq!(
            step_kinds,
            vec![
                WslLinkAgentDistributionStepKind::PrepareDirectories,
                WslLinkAgentDistributionStepKind::WriteAgentBinary,
                WslLinkAgentDistributionStepKind::WriteNoiseConfig,
                WslLinkAgentDistributionStepKind::VerifyInstall,
            ]
        );
        assert_eq!(bundle.steps[0].payload, None);
        assert_eq!(
            bundle.steps[1].payload.as_deref(),
            Some(&b"agent-binary"[..])
        );
        assert!(bundle.steps[2].payload.is_some());
        assert_eq!(bundle.steps[3].payload, None);
    }

    #[test]
    fn distribution_bundle_noise_payload_is_agent_material_json() {
        let bundle = build_agent_distribution_bundle(
            WslLinkAgentDistributionPlan::user_default(),
            b"agent-binary".to_vec(),
        )
        .expect("bundle should build");
        let noise_payload = bundle.steps[2]
            .payload
            .as_ref()
            .expect("noise payload should exist");
        let noise_json = std::str::from_utf8(noise_payload).expect("payload should be utf8 json");
        let agent_material = crate::wsl_link::noise_material::decode_agent_material(noise_json)
            .expect("agent material should decode");

        assert_eq!(
            agent_material.desktop_static_public(),
            bundle.desktop_material.desktop_static_public()
        );
        assert_eq!(
            agent_material.agent_static_public(),
            bundle.desktop_material.agent_static_public()
        );
    }

    #[tokio::test]
    async fn executor_rejects_missing_payload_before_spawn() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let command = plan.write_agent_binary_command();
        let result = run_distribution_command_with_timeout(
            &command,
            None,
            std::time::Duration::from_millis(1),
        )
        .await;

        assert_eq!(
            result,
            Err(WslLinkAgentDistributionError::MissingPayload(
                WslLinkDistributionPayload::AgentBinary
            ))
        );
    }

    #[tokio::test]
    async fn executor_rejects_unexpected_payload_before_spawn() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let command = plan.prepare_command();
        let result = run_distribution_command_with_timeout(
            &command,
            Some(b"payload"),
            std::time::Duration::from_millis(1),
        )
        .await;

        assert_eq!(
            result,
            Err(WslLinkAgentDistributionError::UnexpectedPayload)
        );
    }

    #[tokio::test]
    async fn install_bundle_saves_desktop_material_after_all_steps() {
        let bundle = build_agent_distribution_bundle(
            WslLinkAgentDistributionPlan::user_default(),
            b"agent-binary".to_vec(),
        )
        .expect("bundle should build");
        let store = TestNoiseMaterialStore::default();
        let runner = TestDistributionRunner {
            seen: Arc::new(Mutex::new(Vec::new())),
            fail_at: None,
        };

        let outcome = install_agent_distribution_bundle_with_runner(&bundle, &store, &runner)
            .await
            .expect("install should work");

        assert_eq!(outcome.outputs.len(), 4);
        assert_eq!(
            *runner.seen.lock().expect("test runner lock should work"),
            vec![
                WslLinkAgentDistributionStepKind::PrepareDirectories,
                WslLinkAgentDistributionStepKind::WriteAgentBinary,
                WslLinkAgentDistributionStepKind::WriteNoiseConfig,
                WslLinkAgentDistributionStepKind::VerifyInstall,
            ]
        );
        assert!(*store.saved.lock().expect("test store lock should work"));
    }

    #[tokio::test]
    async fn install_bundle_does_not_save_desktop_material_when_step_fails() {
        let bundle = build_agent_distribution_bundle(
            WslLinkAgentDistributionPlan::user_default(),
            b"agent-binary".to_vec(),
        )
        .expect("bundle should build");
        let store = TestNoiseMaterialStore::default();
        let runner = TestDistributionRunner {
            seen: Arc::new(Mutex::new(Vec::new())),
            fail_at: Some(2),
        };

        let result = install_agent_distribution_bundle_with_runner(&bundle, &store, &runner).await;

        assert!(matches!(
            result,
            Err(WslLinkAgentDistributionError::CommandFailed { .. })
        ));
        assert!(!*store.saved.lock().expect("test store lock should work"));
    }

    #[tokio::test]
    async fn start_installed_agent_returns_runtime_paths() {
        let plan = WslLinkAgentDistributionPlan::user_default();
        let runner = TestDistributionRunner {
            seen: Arc::new(Mutex::new(Vec::new())),
            fail_at: None,
        };

        let outcome = start_installed_agent_with_runner(&plan, &runner)
            .await
            .expect("start should work");

        assert_eq!(outcome.binary_path, plan.binary_path);
        assert_eq!(outcome.noise_config_path, plan.noise_config_path);
        assert_eq!(outcome.pid_path, plan.pid_path);
        assert_eq!(outcome.log_path, plan.log_path);
    }
}
