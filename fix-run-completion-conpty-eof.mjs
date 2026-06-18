// fix-run-completion-conpty-eof.mjs
// 根因：运行读线程靠 read() EOF 判结束，但 Windows ConPTY 在 master 存活时子进程退出后
// 不会 EOF（已知行为）→ RunCompleted 永不发出 → 前端运行指示器不灭、交互提示符被抑制。
// 修复：照 VSCode/node-pty，用独立退出监护线程「等子进程退出→关闭 master 强制 EOF」，
// 退出码经 channel 回传，跨平台无竞态。CRLF 安全、全部命中才写、可重复执行。
import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'src-tauri/src/terminal/wsl_pty.rs';

function run() {
  const raw = readFileSync(PATH, 'utf8');
  const usesCrlf = raw.includes('\r\n');
  let c = usesCrlf ? raw.replaceAll('\r\n', '\n') : raw;

  if (c.includes('wsl-run-exit-') || c.includes('RUN_EXIT_FLUSH_GRACE')) {
    console.log(`• ${PATH}: 已是目标状态，跳过`);
    return;
  }

  const apply = (find, replace, label) => {
    const n = c.split(find).length - 1;
    if (n !== 1) throw new Error(`期望恰好 1 处「${label}」，实际 ${n} 处`);
    c = c.replace(find, replace);
  };

  // C0：新增退出前冲刷窗口常量
  apply(
    `const WSL_SYNC_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);`,
    `const WSL_SYNC_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);\n\n` +
      `/// 子进程退出后、关闭伪控制台前的冲刷窗口：给读线程排空 ConPTY 残留输出的时间，避免截断运行\n` +
      `/// 尾部（最后几行输出 / 退出码）。对照 node-pty 退出后延迟关闭 conpty 以冲刷数据的做法。\n` +
      `const RUN_EXIT_FLUSH_GRACE: Duration = Duration::from_millis(50);`,
    'RUN_EXIT_FLUSH_GRACE 常量',
  );

  // R1：在运行读线程之前插入退出监护线程，并把 master 移交监护线程
  apply(
    `    std::thread::Builder::new()\n` +
      `        .name(format!("wsl-run-{run_id}"))\n` +
      `        .spawn(move || {\n` +
      `            // master 在本线程内保活，确保运行期间 stdin/输出通道有效；运行结束后随线程释放。\n` +
      `            let _master = master;\n` +
      `            on_event(LocalWslTerminalServerPayload::RunStarted(\n`,
    `    // 子进程退出后，ConPTY 输出管道在 master 仍存活时不会自行 EOF（Windows 伪控制台已知行为）：\n` +
      `    // 必须由独立的进程退出信号关闭伪控制台，读线程才能读到 EOF 并收尾。对照 VSCode/node-pty——\n` +
      `    // 以子进程 onExit（而非数据管道 EOF）作为运行结束信号，退出后再关闭 pty 冲刷尾部输出。\n` +
      `    // 故把「等待子进程退出 → 写回退出码 → 关闭 master」下沉到独立退出监护线程；读线程只管读到 EOF。\n` +
      `    let (exit_code_tx, exit_code_rx) = mpsc::channel::<Option<i32>>();\n` +
      `    let mut read_error_killer = child.clone_killer();\n` +
      `    let watch_run_id = run_id.clone();\n` +
      `    std::thread::Builder::new()\n` +
      `        .name(format!("wsl-run-exit-{run_id}"))\n` +
      `        .spawn(move || {\n` +
      `            // master 移交本线程：运行期间保活 stdin/输出通道；子进程退出后关闭它强制读线程 EOF。\n` +
      `            let master = master;\n` +
      `            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);\n` +
      `            // 先把退出码发给读线程，再关闭 master：保证读线程拿到退出码先于 EOF 就绪（跨平台无竞态）。\n` +
      `            let _ = exit_code_tx.send(exit_code);\n` +
      `            // 关闭前留一小段冲刷窗口，让读线程排空 ConPTY 残留输出，避免截断运行尾部。\n` +
      `            std::thread::sleep(RUN_EXIT_FLUSH_GRACE);\n` +
      `            drop(master);\n` +
      `            log::trace!("WSL 运行任务退出监护线程已关闭伪控制台（run_id={watch_run_id}）。");\n` +
      `        })\n` +
      `        .map_err(|error| LocalWslPtyError::Open(error.to_string()))?;\n\n` +
      `    std::thread::Builder::new()\n` +
      `        .name(format!("wsl-run-{run_id}"))\n` +
      `        .spawn(move || {\n` +
      `            on_event(LocalWslTerminalServerPayload::RunStarted(\n`,
    '退出监护线程注入',
  );

  // R2：读线程收尾改为从 channel 取退出码，错误路径改用 read_error_killer
  apply(
    `            // 读取错误退出：先终止可能仍存活的子进程，保证 child.wait() 有界返回、不留孤儿 wsl.exe。\n` +
      `            let exit_reason = if read_error.is_some() { "读取错误" } else { "EOF" };\n` +
      `            if let Some(error) = read_error {\n` +
      `                log::warn!(\n` +
      `                    "WSL 运行任务读线程因读取错误退出（run_id={run_id}）：{error}；强制终止子进程以避免阻塞与孤儿。"\n` +
      `                );\n` +
      `                let _ = child.clone_killer().kill();\n` +
      `            }\n` +
      `            let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);\n` +
      `            cleanup_wsl_paths(&cleanup_paths);\n`,
    `            // 读取错误退出：主动 kill 可能仍存活的子进程，确保退出监护线程的 child.wait() 有界返回。\n` +
      `            let exit_reason = if read_error.is_some() { "读取错误" } else { "EOF" };\n` +
      `            if let Some(error) = read_error {\n` +
      `                log::warn!(\n` +
      `                    "WSL 运行任务读线程因读取错误退出（run_id={run_id}）：{error}；强制终止子进程以避免阻塞与孤儿。"\n` +
      `                );\n` +
      `                let _ = read_error_killer.kill();\n` +
      `            }\n` +
      `            // 退出码由退出监护线程在关闭 master（触发本线程 EOF）之前发来，跨平台均先于 EOF 就绪。\n` +
      `            let exit_code = exit_code_rx.recv().unwrap_or(None);\n` +
      `            cleanup_wsl_paths(&cleanup_paths);\n`,
    '读线程收尾改取 channel 退出码',
  );

  writeFileSync(PATH, usesCrlf ? c.replaceAll('\n', '\r\n') : c, 'utf8');
  console.log(`✓ ${PATH}: 已接入退出监护线程，运行结束检测改由子进程 onExit 驱动${usesCrlf ? '（CRLF 保留）' : ''}`);
}

try {
  run();
  console.log('\n完成。接着执行：cargo build && pnpm tauri dev，跑个脚本验证：结束后绿点应熄灭、提示符正常回来。');
} catch (err) {
  console.error(`✗ ${PATH}: ${err.message}\n未通过校验，文件未写入。`);
  process.exitCode = 1;
}