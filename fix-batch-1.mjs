// fix-batch-2.mjs
// Calamex 代码审查第二批修复：M-4 / M-2 / L-4 / L-7
// 用法: node fix-batch-2.mjs
// 在仓库根目录 D:\com.xiaojianc\my_desktop_app 下运行

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 工具函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function replaceExact(filePath, oldStr, newStr, label) {
  const abs = join(root, filePath);
  const content = readFileSync(abs, 'utf-8');

  const count = content.split(oldStr).length - 1;
  if (count === 0) {
    throw new Error(`[${label}] 未找到匹配的原始代码块:\n  ${filePath}`);
  }
  if (count > 1) {
    throw new Error(`[${label}] 原始代码块匹配了 ${count} 处:\n  ${filePath}`);
  }

  const result = content.replace(oldStr, newStr);
  writeFileSync(abs, result, 'utf-8');
  console.log(`✅ [${label}] 已修改: ${filePath}`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// M-4: git.ts — 简化 requestIdleCallback fallback 逻辑
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const M4_FILE = 'src/store/git.ts';

const M4_OLD = `  const scheduleCommitStatsBackgroundQueue = (): void => {
    if (commitStatsBackgroundTimer !== null || isCommitStatsBackgroundRunning) return;

    const run = (): void => {
      commitStatsBackgroundTimer = null;
      void drainCommitStatsBackgroundQueue();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      let didRun = false;
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

      const runOnce = (): void => {
        if (didRun) return;
        didRun = true;
        if (fallbackTimer !== null) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        run();
      };

      const idleId = window.requestIdleCallback(runOnce, {
        timeout: GIT_COMMIT_STATS_BACKGROUND_DELAY_MS * 4,
      });

      fallbackTimer = setTimeout(() => {
        window.cancelIdleCallback?.(idleId);
        runOnce();
      }, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS * 4);
      commitStatsBackgroundTimer = fallbackTimer;
      return;
    }

    commitStatsBackgroundTimer = setTimeout(run, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS);
  };`;

const M4_NEW = `  const scheduleCommitStatsBackgroundQueue = (): void => {
    if (commitStatsBackgroundTimer !== null || isCommitStatsBackgroundRunning) return;

    const run = (): void => {
      commitStatsBackgroundTimer = null;
      void drainCommitStatsBackgroundQueue();
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      // requestIdleCallback 的 timeout 参数保证回调最终一定执行，
      // 不需要额外加 setTimeout fallback（原双层超时是冗余的防御）。
      // commitStatsBackgroundTimer 存 idleId，取消时用 cancelIdleCallback。
      const idleId = window.requestIdleCallback(run, {
        timeout: GIT_COMMIT_STATS_BACKGROUND_DELAY_MS * 4,
      });
      // 保存 idleId 以便 clearCommitStatsBackgroundQueue 取消。
      // 不支持 cancelIdleCallback 的环境（旧 WebView2）退化为 no-op。
      commitStatsBackgroundTimer = idleId as unknown as ReturnType<typeof setTimeout>;
      return;
    }

    commitStatsBackgroundTimer = setTimeout(run, GIT_COMMIT_STATS_BACKGROUND_DELAY_MS);
  };`;

// clearCommitStatsBackgroundQueue 也需要修改，因为现在 timer 可能是 idleId
const M4_OLD_CLEAR = `  const clearCommitStatsBackgroundQueue = (): void => {
    if (commitStatsBackgroundTimer !== null) {
      clearTimeout(commitStatsBackgroundTimer);
      commitStatsBackgroundTimer = null;
    }
    queuedCommitStatsIds.clear();
    pendingCommitStatsRequests.clear();
    isCommitStatsBackgroundRunning = false;
  };`;

const M4_NEW_CLEAR = `  const clearCommitStatsBackgroundQueue = (): void => {
    if (commitStatsBackgroundTimer !== null) {
      // timer 可能是 setTimeout handle 或 requestIdleCallback handle。
      // 两种都尝试取消：cancelIdleCallback 不支持时静默跳过。
      if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(commitStatsBackgroundTimer as unknown as number);
      }
      clearTimeout(commitStatsBackgroundTimer);
      commitStatsBackgroundTimer = null;
    }
    queuedCommitStatsIds.clear();
    pendingCommitStatsRequests.clear();
    isCommitStatsBackgroundRunning = false;
  };`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// M-2: useShellWorkbenchView.ts — 魔法数字提取为具名常量
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const M2_FILE = 'src/composables/useShellWorkbenchView.ts';

// 在已有常量区追加终端面板常量
const M2_OLD_CONSTS = `const DASHBOARD_SIDEBAR_WIDTH = 288;`;

const M2_NEW_CONSTS = `const DASHBOARD_SIDEBAR_WIDTH = 288;

// 终端面板默认高度（约 8-10 行终端输出）。
const TERMINAL_DEFAULT_HEIGHT = 236;
// 终端最大化时使用的像素值：远超任何屏幕高度，撑满 flex 父容器。
const TERMINAL_MAXIMIZED_PX = 100_000;`;

// 替换 ref(236) 为具名常量
const M2_OLD_REFS = `  const terminalHeight = ref(236);
  const terminalHeightBeforeMaximize = ref(236);`;

const M2_NEW_REFS = `  const terminalHeight = ref(TERMINAL_DEFAULT_HEIGHT);
  const terminalHeightBeforeMaximize = ref(TERMINAL_DEFAULT_HEIGHT);`;

// 替换终端最大化处的 100000
const M2_OLD_MAXIMIZE = `    terminalHeightBeforeMaximize.value = terminalHeight.value;
    isTerminalMaximized.value = true;
    terminalHeight.value = 100000;`;

const M2_NEW_MAXIMIZE = `    terminalHeightBeforeMaximize.value = terminalHeight.value;
    isTerminalMaximized.value = true;
    terminalHeight.value = TERMINAL_MAXIMIZED_PX;`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L-4: agent_webview.rs — CDP 重试常量提取
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const L4_FILE = 'src-tauri/src/commands/agent_webview.rs';

// 在已有常量区追加 CDP 连接参数
const L4_OLD_CONSTS = `#[cfg(feature = "native_webview")]
const RESULT_BINDING_NAME: &str = "__calamexPickerResult";`;

const L4_NEW_CONSTS = `#[cfg(feature = "native_webview")]
const RESULT_BINDING_NAME: &str = "__calamexPickerResult";

/// CDP 连接最大重试次数。
/// 40 次 × 250ms = 最长 10 秒等待 agent-sidecar WebView 的调试端口就绪。
#[cfg(feature = "native_webview")]
const CDP_CONNECT_MAX_RETRIES: usize = 40;

/// CDP 连接重试间隔。
/// 250ms 在「快速感知就绪」与「避免忙等」之间取折中。
#[cfg(feature = "native_webview")]
const CDP_CONNECT_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);`;

// 第一处 for _ in 0..40（CDP Browser::connect）
const L4_OLD_LOOP1 = `    let mut connected = None;
    for _ in 0..40 {
        // 检查 webview 是否已被关闭/销毁，避免在用户关闭后继续建立 CDP 会话。
        if app.get_webview(AGENT_WEBVIEW_LABEL).is_none() {
            tracing::info!(event = "agent_webview.cdp.cancelled", reason = "webview_closed");
            return;
        }
        match chromiumoxide::Browser::connect(url.clone()).await {
            Ok(pair) => {
                connected = Some(pair);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(250)).await,
        }
    }`;

const L4_NEW_LOOP1 = `    let mut connected = None;
    for _ in 0..CDP_CONNECT_MAX_RETRIES {
        // 检查 webview 是否已被关闭/销毁，避免在用户关闭后继续建立 CDP 会话。
        if app.get_webview(AGENT_WEBVIEW_LABEL).is_none() {
            tracing::info!(event = "agent_webview.cdp.cancelled", reason = "webview_closed");
            return;
        }
        match chromiumoxide::Browser::connect(url.clone()).await {
            Ok(pair) => {
                connected = Some(pair);
                break;
            }
            Err(_) => tokio::time::sleep(CDP_CONNECT_RETRY_INTERVAL).await,
        }
    }`;

// 第二处 for _ in 0..40（获取 Page）
const L4_OLD_LOOP2 = `    let mut page_opt = None;
    for _ in 0..40 {
        // 检查 webview 是否已被关闭/销毁。
        if app.get_webview(AGENT_WEBVIEW_LABEL).is_none() {
            tracing::info!(event = "agent_webview.cdp.cancelled", reason = "webview_closed");
            handler_task.abort();
            return;
        }
        if let Ok(pages) = browser.pages().await
            && let Some(first) = pages.into_iter().next()
        {
            page_opt = Some(first);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }`;

const L4_NEW_LOOP2 = `    let mut page_opt = None;
    for _ in 0..CDP_CONNECT_MAX_RETRIES {
        // 检查 webview 是否已被关闭/销毁。
        if app.get_webview(AGENT_WEBVIEW_LABEL).is_none() {
            tracing::info!(event = "agent_webview.cdp.cancelled", reason = "webview_closed");
            handler_task.abort();
            return;
        }
        if let Ok(pages) = browser.pages().await
            && let Some(first) = pages.into_iter().next()
        {
            page_opt = Some(first);
            break;
        }
        tokio::time::sleep(CDP_CONNECT_RETRY_INTERVAL).await;
    }`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L-7: shell_tools.rs + workspace_fs.rs — 合并重复的 count_to_u32
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// workspace_fs.rs 中已有 count_to_u32 且被多处调用（build_script_payload / build_image_asset_payload）。
// shell_tools.rs 中也有独立的 count_to_u32，被 format_script 调用。
// 方案：把 shell_tools.rs 中的 count_to_u32 改为复用 workspace_fs 的 pub(crate) 版本。
// 但 shell_tools.rs 和 workspace_fs.rs 在同一 mod（commands）下，
// workspace_fs 的 count_to_u32 是 private fn——需要先改成 pub(crate)。

const L7_FS_FILE = 'src-tauri/src/commands/workspace_fs.rs';
const L7_TOOLS_FILE = 'src-tauri/src/commands/shell_tools.rs';

// 1) workspace_fs.rs: fn count_to_u32 → pub(crate) fn count_to_u32
const L7_OLD_FS_FN = `fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}`;

const L7_NEW_FS_FN = `pub(crate) fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}`;

// 2) shell_tools.rs: 删除重复的 count_to_u32，改为引用 super::count_to_u32
// 先改 use 语句加入 count_to_u32
const L7_OLD_TOOLS_USE = `use super::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
    configure_std_command_for_background, configure_tokio_command_for_background,
};`;

const L7_NEW_TOOLS_USE = `use super::{
    AnalyzeScriptPayload, AnalyzeScriptRequest, FormatScriptPayload, FormatScriptRequest,
    configure_std_command_for_background, configure_tokio_command_for_background, count_to_u32,
};`;

// 删除 shell_tools.rs 中的 count_to_u32 定义
const L7_OLD_TOOLS_FN = `fn count_to_u32(value: usize, label: &str) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| format!("{label}超出支持范围。"))
}

`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 执行
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

console.log('══════════════════════════════════════════════');
console.log('  Calamex 代码审查第二批修复 (M-4 / M-2 / L-4 / L-7)');
console.log('  工作目录:', root);
console.log('══════════════════════════════════════════════\\n');

try {
  // M-4: 简化 requestIdleCallback fallback
  replaceExact(M4_FILE, M4_OLD, M4_NEW, 'M-4 schedule');
  replaceExact(M4_FILE, M4_OLD_CLEAR, M4_NEW_CLEAR, 'M-4 clear');

  // M-2: 魔法数字提取
  replaceExact(M2_FILE, M2_OLD_CONSTS, M2_NEW_CONSTS, 'M-2 consts');
  replaceExact(M2_FILE, M2_OLD_REFS, M2_NEW_REFS, 'M-2 refs');
  replaceExact(M2_FILE, M2_OLD_MAXIMIZE, M2_NEW_MAXIMIZE, 'M-2 maximize');

  // L-4: CDP 重试常量
  replaceExact(L4_FILE, L4_OLD_CONSTS, L4_NEW_CONSTS, 'L-4 consts');
  replaceExact(L4_FILE, L4_OLD_LOOP1, L4_NEW_LOOP1, 'L-4 loop1');
  replaceExact(L4_FILE, L4_OLD_LOOP2, L4_NEW_LOOP2, 'L-4 loop2');

  // L-7: 合并重复 count_to_u32
  replaceExact(L7_FS_FILE, L7_OLD_FS_FN, L7_NEW_FS_FN, 'L-7 fs fn');
  replaceExact(L7_TOOLS_FILE, L7_OLD_TOOLS_USE, L7_NEW_TOOLS_USE, 'L-7 tools use');
  replaceExact(L7_TOOLS_FILE, L7_OLD_TOOLS_FN, '', 'L-7 tools fn delete');

  console.log('\\n══════════════════════════════════════════════');
  console.log('  ✓ 全部第二批修复完成');
  console.log('  验证命令:');
  console.log('    pnpm tsc --noEmit');
  console.log('    cargo clippy --manifest-path src-tauri/Cargo.toml');
  console.log('    cargo test --manifest-path src-tauri/Cargo.toml');
  console.log('══════════════════════════════════════════════');
} catch (error) {
  console.error('\\n✗ 修改失败:', error.message);
  process.exit(1);
}