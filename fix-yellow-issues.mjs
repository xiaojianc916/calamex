#!/usr/bin/env node
// fix-yellow-issues.mjs — 修复全部 🟡 级别问题（11 项，跨 8 个文件）
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const P = 'src-tauri/src/';

function nl(s) { return s.replace(/\r\n/g, '\n'); }

let results = [];

function patch(relPath, oldStr, newStr, label) {
  const full = ROOT + '/' + (relPath.startsWith('src-tauri') ? relPath : P + relPath);
  let content = nl(readFileSync(full, 'utf8'));
  const oldN = nl(oldStr);
  const newN = nl(newStr);

  if (content.includes(newN)) {
    results.push(`✅ ${label} (already applied)`);
    return;
  }
  if (!content.includes(oldN)) {
    results.push(`❌ ${label} (old string not found)`);
    return;
  }
  content = content.replace(oldN, newN);
  writeFileSync(full, content, 'utf8');
  results.push(`✅ ${label}`);
}

// ═══════════════════════════════════════════════════════════════════════
// terminal/state.rs — #1: 添加 shutdown 字段 + AtomicBool import
// ═══════════════════════════════════════════════════════════════════════

patch('commands/terminal/state.rs',
`use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};`,
`use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, atomic::AtomicBool},
    time::{Duration, Instant},
};`,
'state.rs: import AtomicBool');

patch('commands/terminal/state.rs',
`    session_liveness: Arc<Mutex<HashMap<String, Instant>>>,
    pub(super) creation_guard: Arc<Mutex<()>>,
}`,
`    session_liveness: Arc<Mutex<HashMap<String, Instant>>>,
    /// 优雅关闭信号：设为 true 时孤儿收割线程退出循环。
    pub(super) shutdown: Arc<AtomicBool>,
    pub(super) creation_guard: Arc<Mutex<()>>,
    // TODO(design): 9 个独立 Arc<Mutex<HashMap>> 增加锁复杂度。
    // remove_interactive_terminal_after_exit 串行获取 8 次锁。
    // 可考虑将 snapshots + interactive_visual 等常同时访问的 map 合并为单一 struct。
}`,
'state.rs: add shutdown field + TODO');

// ═══════════════════════════════════════════════════════════════════════
// terminal/state.rs — #11: should_recreate_terminal_session 精确匹配 Windows 驱动器号
// ═══════════════════════════════════════════════════════════════════════

patch('commands/terminal/state.rs',
`pub(super) fn should_recreate_terminal_session(session: &TerminalSession) -> bool {
    let cwd = session.working_directory.trim();
    cwd.is_empty()
        || cwd.contains('\\\\')
        || cwd.contains(':')
        || (!cwd.starts_with('/') && cwd != "~")
}`,
`pub(super) fn should_recreate_terminal_session(session: &TerminalSession) -> bool {
    let cwd = session.working_directory.trim();
    cwd.is_empty()
        || cwd.contains('\\\\')
        || looks_like_windows_drive_path(cwd)
        || (!cwd.starts_with('/') && cwd != "~")
}

/// 检测 Windows 驱动器号路径（如 \`C:\\\` 或 \`C:/\`），避免误判含 \`:\` 的 Linux 路径。
fn looks_like_windows_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\\\' || bytes[2] == b'/')
}`,
'state.rs: precise Windows path detection');

// ═══════════════════════════════════════════════════════════════════════
// terminal/commands.rs — #1: 孤儿收割线程加 shutdown 检查
// ═══════════════════════════════════════════════════════════════════════

patch('commands/terminal/commands.rs',
`pub fn shutdown_all_terminal_sessions(state: &TerminalSessionState) -> Result<(), String> {
    let _creation_guard = state
        .creation_guard
        .lock()
        .map_err(|_| "终端会话创建锁已损坏。".to_string())?;`,
`pub fn shutdown_all_terminal_sessions(state: &TerminalSessionState) -> Result<(), String> {
    // 通知孤儿收割线程退出循环。
    state
        .shutdown
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let _creation_guard = state
        .creation_guard
        .lock()
        .map_err(|_| "终端会话创建锁已损坏。".to_string())?;`,
'commands.rs: signal shutdown in shutdown_all');

patch('commands/terminal/commands.rs',
`        .name("wsl-orphan-session-reaper".to_string())
        .spawn(move || {
            loop {
                std::thread::sleep(ORPHAN_SESSION_REAP_POLL);
                reap_idle_orphan_terminal_sessions(&app, &state, ORPHAN_SESSION_REAP_GRACE);
            }
        });`,
`        .name("wsl-orphan-session-reaper".to_string())
        .spawn(move || {
            while !state.shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::sleep(ORPHAN_SESSION_REAP_POLL);
                if state.shutdown.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                reap_idle_orphan_terminal_sessions(&app, &state, ORPHAN_SESSION_REAP_GRACE);
            }
        });`,
'commands.rs: reaper checks shutdown signal');

// ═══════════════════════════════════════════════════════════════════════
// terminal/events.rs — #7: sanitize 只在冷启动时剥离 "wsl:" 行
// ═══════════════════════════════════════════════════════════════════════

patch('commands/terminal/events.rs',
`pub(super) fn sanitize_terminal_run_chunk(data: &str, has_prior_output: bool) -> String {
    let without_banner = strip_wsl_diagnostic_lines(data);
    if has_prior_output {
        return without_banner;
    }
    strip_leading_screen_init(&without_banner)
}`,
`pub(super) fn sanitize_terminal_run_chunk(data: &str, has_prior_output: bool) -> String {
    // WSL 诊断行（"wsl: ..."）仅在冷启动时出现，已有输出时不再剥离，
    // 避免误删用户脚本中合法的 "wsl:" 前缀行。
    if has_prior_output {
        return data.to_string();
    }
    let without_banner = strip_wsl_diagnostic_lines(data);
    strip_leading_screen_init(&without_banner)
}`,
'events.rs: only strip wsl: on cold start');

// ═══════════════════════════════════════════════════════════════════════
// search/find.rs — #6: FuzzyLinePrefilter 用栈上 [bool;256] 位掩码替代每行 clone Vec
// ═══════════════════════════════════════════════════════════════════════

patch('commands/search/find.rs',
`#[derive(Clone)]
struct FuzzyLinePrefilter {
    min_chars: usize,
    required_ascii: Vec<u8>,
    required_non_ascii: Vec<char>,
    match_case: bool,
}

impl FuzzyLinePrefilter {
    fn new(query: &str, match_case: bool) -> Option<Self> {
        let min_chars = query.chars().filter(|ch| !ch.is_whitespace()).count();
        let mut required_ascii = Vec::new();
        let mut required_non_ascii = Vec::new();

        for ch in query.chars() {
            if ch.is_whitespace() {
                continue;
            }
            if ch.is_ascii() {
                let byte = ch as u8;
                if !byte.is_ascii_alphanumeric() {
                    continue;
                }
                let normalized = normalize_prefilter_ascii(byte, match_case);
                if !required_ascii.contains(&normalized) {
                    required_ascii.push(normalized);
                }
                continue;
            }
            // 非 ASCII：仅在区分大小写、或该字符本身无大小写之分（如 CJK）时要求其出现，
            // 避免在不区分大小写时对有大小写的脚本（希腊 / 西里尔等）造成误杀。
            if !match_case && (ch.is_uppercase() || ch.is_lowercase()) {
                continue;
            }
            if !required_non_ascii.contains(&ch) {
                required_non_ascii.push(ch);
            }
        }

        if min_chars == 0 && required_ascii.is_empty() && required_non_ascii.is_empty() {
            return None;
        }

        Some(Self {
            min_chars,
            required_ascii,
            required_non_ascii,
            match_case,
        })
    }

    /// 在给定字节序列中检查 query 要求的全部 ASCII 字符是否都出现（按 match_case 归一大小写）。
    /// 非 ASCII 字节跳过；调用方需保证 required_ascii 非空时调用才有意义。
    fn all_required_ascii_present(&self, bytes: impl Iterator<Item = u8>) -> bool {
        let mut missing = self.required_ascii.clone();
        for byte in bytes {
            if !byte.is_ascii() {
                continue;
            }
            let normalized = normalize_prefilter_ascii(byte, self.match_case);
            if let Some(index) = missing
                .iter()
                .position(|candidate| *candidate == normalized)
            {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }
        false
    }

    /// 在已解码的行文本上检查 query 要求的全部非 ASCII（无大小写之分，如 CJK）字符是否都出现。
    /// 仅对解码后的文本调用；文件级原始字节阶段不做此检查，以免对非 UTF-8 编码误杀。
    fn all_required_non_ascii_present(&self, line: &str) -> bool {
        let mut missing = self.required_non_ascii.clone();
        for ch in line.chars() {
            if let Some(index) = missing.iter().position(|candidate| *candidate == ch) {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }
        missing.is_empty()
    }

    fn may_match(&self, line: &str) -> bool {
        if line.chars().count() < self.min_chars {
            return false;
        }
        if !self.required_ascii.is_empty() && !self.all_required_ascii_present(line.bytes()) {
            return false;
        }
        if !self.required_non_ascii.is_empty() && !self.all_required_non_ascii_present(line) {
            return false;
        }
        true
    }

    /// 文件级候选筛除（第 4 点两阶段检索的「candidate generation」轻量版）：
    /// 直接在原始字节上检查 query 要求的 ASCII 字符是否全部出现；缺任意一个，
    /// 则整文件不可能有命中行，可在更贵的解码 / 逐行 nucleo 之前整文件跳过。
    ///
    /// 只看 ASCII 字节，且 ASCII 在 UTF-8 / Latin1 等超集编码里编码一致，故无需先解码，
    /// 也不会误杀（required_ascii 为空时返回 true，交回逐行阶段处理）。非 ASCII（如 CJK）
    /// 字符的存在性检查只放在解码后的逐行阶段，避免对非 UTF-8 编码的文件误杀。
    fn bytes_may_match(&self, bytes: &[u8]) -> bool {
        if self.required_ascii.is_empty() {
            return true;
        }
        self.all_required_ascii_present(bytes.iter().copied())
    }
}`,
`#[derive(Clone)]
struct FuzzyLinePrefilter {
    min_chars: usize,
    /// ASCII 字符存在性位掩码：索引为归一化后的 ASCII 字节值。
    /// 替代原先的 Vec<u8>，避免 each-call clone 产生的堆分配。
    required_ascii_mask: [bool; 256],
    required_ascii_count: usize,
    required_non_ascii: Vec<char>,
    match_case: bool,
}

impl FuzzyLinePrefilter {
    fn new(query: &str, match_case: bool) -> Option<Self> {
        let min_chars = query.chars().filter(|ch| !ch.is_whitespace()).count();
        let mut required_ascii_mask = [false; 256];
        let mut required_ascii_count = 0usize;
        let mut required_non_ascii = Vec::new();

        for ch in query.chars() {
            if ch.is_whitespace() {
                continue;
            }
            if ch.is_ascii() {
                let byte = ch as u8;
                if !byte.is_ascii_alphanumeric() {
                    continue;
                }
                let normalized = normalize_prefilter_ascii(byte, match_case);
                if !required_ascii_mask[normalized as usize] {
                    required_ascii_mask[normalized as usize] = true;
                    required_ascii_count += 1;
                }
                continue;
            }
            // 非 ASCII：仅在区分大小写、或该字符本身无大小写之分（如 CJK）时要求其出现，
            // 避免在不区分大小写时对有大小写的脚本（希腊 / 西里尔等）造成误杀。
            if !match_case && (ch.is_uppercase() || ch.is_lowercase()) {
                continue;
            }
            if !required_non_ascii.contains(&ch) {
                required_non_ascii.push(ch);
            }
        }

        if min_chars == 0 && required_ascii_count == 0 && required_non_ascii.is_empty() {
            return None;
        }

        Some(Self {
            min_chars,
            required_ascii_mask,
            required_ascii_count,
            required_non_ascii,
            match_case,
        })
    }

    /// 在给定字节序列中检查 query 要求的全部 ASCII 字符是否都出现（按 match_case 归一大小写）。
    /// 非 ASCII 字节跳过。使用栈上 [bool; 256] 位掩码替代 Vec clone，零堆分配。
    fn all_required_ascii_present(&self, bytes: impl Iterator<Item = u8>) -> bool {
        if self.required_ascii_count == 0 {
            return true;
        }
        let mut present = [false; 256];
        let mut found = 0usize;
        for byte in bytes {
            if !byte.is_ascii() {
                continue;
            }
            let normalized = normalize_prefilter_ascii(byte, self.match_case);
            let idx = normalized as usize;
            if self.required_ascii_mask[idx] && !present[idx] {
                present[idx] = true;
                found += 1;
                if found == self.required_ascii_count {
                    return true;
                }
            }
        }
        false
    }

    /// 在已解码的行文本上检查 query 要求的全部非 ASCII（无大小写之分，如 CJK）字符是否都出现。
    /// 仅对解码后的文本调用；文件级原始字节阶段不做此检查，以免对非 UTF-8 编码误杀。
    fn all_required_non_ascii_present(&self, line: &str) -> bool {
        let mut missing = self.required_non_ascii.clone();
        for ch in line.chars() {
            if let Some(index) = missing.iter().position(|candidate| *candidate == ch) {
                missing.swap_remove(index);
                if missing.is_empty() {
                    return true;
                }
            }
        }
        missing.is_empty()
    }

    fn may_match(&self, line: &str) -> bool {
        if line.chars().count() < self.min_chars {
            return false;
        }
        if self.required_ascii_count > 0 && !self.all_required_ascii_present(line.bytes()) {
            return false;
        }
        if !self.required_non_ascii.is_empty() && !self.all_required_non_ascii_present(line) {
            return false;
        }
        true
    }

    /// 文件级候选筛除（第 4 点两阶段检索的「candidate generation」轻量版）：
    /// 直接在原始字节上检查 query 要求的 ASCII 字符是否全部出现；缺任意一个，
    /// 则整文件不可能有命中行，可在更贵的解码 / 逐行 nucleo 之前整文件跳过。
    ///
    /// 只看 ASCII 字节，且 ASCII 在 UTF-8 / Latin1 等超集编码里编码一致，故无需先解码，
    /// 也不会误杀（required_ascii 为空时返回 true，交回逐行阶段处理）。非 ASCII（如 CJK）
    /// 字符的存在性检查只放在解码后的逐行阶段，避免对非 UTF-8 编码的文件误杀。
    fn bytes_may_match(&self, bytes: &[u8]) -> bool {
        if self.required_ascii_count == 0 {
            return true;
        }
        self.all_required_ascii_present(bytes.iter().copied())
    }
}`,
'find.rs: FuzzyLinePrefilter bitmask (zero heap alloc)');

// ═══════════════════════════════════════════════════════════════════════
// search/find.rs — #2: conversion_error 设置后停止扫描
// ═══════════════════════════════════════════════════════════════════════

patch('commands/search/find.rs',
`                    .map_err(io::Error::other)?;
                Ok(keep_going)
            }),`,
`                    .map_err(io::Error::other)?;
                Ok(keep_going && conversion_error.is_none())
            }),`,
'find.rs: stop scanning on conversion_error');

// ═══════════════════════════════════════════════════════════════════════
// search/mod.rs — #9: prewarm 静默吞掉线程创建失败 → log::warn
// ═══════════════════════════════════════════════════════════════════════

patch('commands/search/mod.rs',
`        })
        .ok();
}`,
`        })
    {
        log::warn!("搜索索引预热线程创建失败：{error}");
    }
}`,
'search/mod.rs: log::warn on prewarm thread failure');

// ═══════════════════════════════════════════════════════════════════════
// commands/git.rs — #3: short_commit_id 单次分配
// ═══════════════════════════════════════════════════════════════════════

patch('commands/git.rs',
`fn short_commit_id(id: gix::ObjectId) -> String {
    id.to_string().chars().take(7).collect()
}`,
`fn short_commit_id(id: gix::ObjectId) -> String {
    format!("{:.7}", id)
}`,
'git.rs: short_commit_id single allocation');

// ═══════════════════════════════════════════════════════════════════════
// commands/git.rs — #10: epoch 0 时间戳返回空串
// ═══════════════════════════════════════════════════════════════════════

patch('commands/git.rs',
`    let authored_at = jiff::Timestamp::from_second(commit.time().unwrap_or_default().seconds)
        .unwrap_or_else(|_| jiff::Timestamp::now())
        .to_string();`,
`    let time_seconds = commit.time().map(|t| t.seconds).unwrap_or(0);
    let authored_at = if time_seconds == 0 {
        // epoch 0 通常表示时间缺失，返回空串让前端区分"时间缺失"与"真实时间"。
        String::new()
    } else {
        jiff::Timestamp::from_second(time_seconds)
            .unwrap_or_else(|_| jiff::Timestamp::now())
            .to_string()
    };`,
'git.rs: epoch 0 returns empty string');

// ═══════════════════════════════════════════════════════════════════════
// commands/shell_tools.rs — #8: 超时时捕获部分 stderr
// ═══════════════════════════════════════════════════════════════════════

patch('commands/shell_tools.rs',
`use std::{
    env,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    time::Duration,
};`,
`use std::{
    env,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};`,
'shell_tools.rs: import Arc');

patch('commands/shell_tools.rs',
`    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 shfmt 失败：{error}"))?;

    // 并发写 stdin：与排空 stdout 同时进行，避免大脚本触发 stdin/stdout 双向管道死锁。
    let stdin = child.stdin.take();
    let input = content.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
        }
        Ok::<(), std::io::Error>(())
    });

    let output = match timeout(SHFMT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("运行 shfmt 失败：{error}")),
        Err(_) => {
            return Err(format!(
                "shfmt 格式化超时（超过 {} 秒）。",
                SHFMT_TIMEOUT.as_secs()
            ));
        }
    };`,
`    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 shfmt 失败：{error}"))?;

    // 独立读取 stderr：超时时 wait_with_output 的 future 被 drop，
    // 已缓冲的 stderr 诊断信息会丢失。提前 take stderr 管道由独立任务持续读取，
    // 超时后仍能获得部分诊断输出（如语法错误位置）。
    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let partial_stderr: Arc<std::sync::Mutex<Vec<u8>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let partial_stderr_clone = partial_stderr.clone();
    let stderr_reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        loop {
            match stderr_pipe.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => partial_stderr_clone
                    .lock()
                    .unwrap()
                    .extend_from_slice(&buf[..n]),
            }
        }
    });

    // 并发写 stdin：与排空 stdout 同时进行，避免大脚本触发 stdin/stdout 双向管道死锁。
    let stdin = child.stdin.take();
    let input = content.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            stdin.write_all(&input).await?;
            stdin.shutdown().await?;
        }
        Ok::<(), std::io::Error>(())
    });

    let output = match timeout(SHFMT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(mut output)) => {
            // wait 返回后合并 stderr_reader 已捕获的完整 stderr。
            let _ = stderr_reader.await;
            output.stderr = std::mem::take(&mut *partial_stderr.lock().unwrap());
            output
        }
        Ok(Err(error)) => return Err(format!("运行 shfmt 失败：{error}")),
        Err(_) => {
            // 超时：从 partial_stderr 获取已缓冲的 stderr 内容。
            let stderr_text =
                String::from_utf8_lossy(&partial_stderr.lock().unwrap())
                    .trim()
                    .to_string();
            let base = format!(
                "shfmt 格式化超时（超过 {} 秒）。",
                SHFMT_TIMEOUT.as_secs()
            );
            return Err(if stderr_text.is_empty() {
                base
            } else {
                format!("{base} 部分诊断输出：{stderr_text}")
            });
        }
    };`,
'shell_tools.rs: capture partial stderr on timeout');

// ═══════════════════════════════════════════════════════════════════════
// commands/agent_webview.rs — #4: CDP 轮询循环中检查 webview 是否已关闭
// ═══════════════════════════════════════════════════════════════════════

patch('commands/agent_webview.rs',
`async fn establish_cdp_session(app: AppHandle, port: u16) {
    use futures::StreamExt;`,
`async fn establish_cdp_session(app: AppHandle, port: u16) {
    use futures::StreamExt;
    use tauri::Manager;`,
'agent_webview.rs: import Manager in establish_cdp_session');

patch('commands/agent_webview.rs',
`    for _ in 0..40 {
        match chromiumoxide::Browser::connect(url.clone()).await {`,
`    for _ in 0..40 {
        // 检查 webview 是否已被关闭/销毁，避免在用户关闭后继续建立 CDP 会话。
        if app.get_webview(AGENT_WEBVIEW_LABEL).is_none() {
            tracing::info!(event = "agent_webview.cdp.cancelled", reason = "webview_closed");
            return;
        }
        match chromiumoxide::Browser::connect(url.clone()).await {`,
'agent_webview.rs: check webview in CDP connect loop');

patch('commands/agent_webview.rs',
`    let mut page_opt = None;
    for _ in 0..40 {
        if let Ok(pages) = browser.pages().await`,
`    let mut page_opt = None;
    for _ in 0..40 {
        // 检查 webview 是否已被关闭/销毁。
        if app.get_webview(AGENT_WEBVIEW_LABEL).is_none() {
            tracing::info!(event = "agent_webview.cdp.cancelled", reason = "webview_closed");
            handler_task.abort();
            return;
        }
        if let Ok(pages) = browser.pages().await`,
'agent_webview.rs: check webview in CDP page loop');

// ═══════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════

console.log('\n──────────────────────────────');
console.log('Yellow issue fixes — Results:');
console.log('──────────────────────────────');
for (const r of results) console.log(r);
const ok = results.filter(r => r.startsWith('✅')).length;
const fail = results.filter(r => r.startsWith('❌')).length;
console.log(`──────────────────────────────`);
console.log(`${ok}/${results.length} succeeded, ${fail} failed`);