#!/usr/bin/env node
// 仅修补 src-tauri/src/main.rs（打包加固 + 关联文件打开），LF/CRLF 兼容、幂等可重跑。
// 用法（仓库根目录）：node 2.mjs   或   node 2.mjs <仓库根目录>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.cwd());
const REL = 'src-tauri/src/main.rs';
if (!existsSync(join(ROOT, REL))) {
  console.error(`✗ 找不到 ${REL}，请在 calamex 仓库根目录运行。当前：${ROOT}`);
  process.exit(1);
}

const raw = readFileSync(join(ROOT, REL), 'utf8');
const isCRLF = raw.includes('\r\n');
let s = raw.replace(/\r\n/g, '\n'); // 归一化为 LF 再匹配

const log = [];
let hadError = false;
function patch(label, find, repl, marker) {
  if (s.includes(marker)) { log.push(`· 跳过  ${label}`); return; }
  if (!s.includes(find)) { log.push(`✗ 失败  ${label}（锚点仍未找到，请手动检查）`); hadError = true; return; }
  s = s.replace(find, () => repl);
  log.push(`✓ 完成  ${label}`);
}

// 1) 引入 Emitter
patch('引入 Emitter',
  'use tauri::{\n    Manager, WindowEvent,',
  'use tauri::{\n    Emitter, Manager, WindowEvent,',
  '    Emitter, Manager, WindowEvent,');

// 2) 关联文件解析/广播函数（插在 reveal_main_window 之后）
const revealFn =
`fn reveal_main_window<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) {
    let Some(window) = app_handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}`;
const openFns =
`

const OPEN_FILE_EVENT: &str = "calamex://open-file";

/// 从进程启动参数中提取可打开的脚本路径（关联文件双击 / 命令行传入）。
/// 跳过 argv[0]（程序自身）与以 - 开头的选项，仅保留确实存在的 .sh/.bash 文件。
fn extract_openable_files(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| {
            let path = std::path::Path::new(arg.as_str());
            let is_shell = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("sh") || ext.eq_ignore_ascii_case("bash"))
                .unwrap_or(false);
            is_shell && path.is_file()
        })
        .cloned()
        .collect()
}

/// 把启动参数里的待打开文件逐个发往前端（事件名 calamex://open-file，payload 为绝对路径）。
fn emit_open_files<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>, argv: &[String]) {
    for path in extract_openable_files(argv) {
        if let Err(error) = app_handle.emit(OPEN_FILE_EVENT, path.clone()) {
            tracing::warn!("failed to emit open-file event for {path}: {error}");
        }
    }
}`;
patch('关联文件解析/广播函数', revealFn, revealFn + openFns, 'fn extract_openable_files');

// 3) init_tracing 改为文件滚动日志（返回 guard）
const oldInit =
`fn init_tracing() {
    use tracing_subscriber::{EnvFilter, fmt};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}`;
const newInit =
`fn init_tracing() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{
        EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt,
    };

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    // 文件日志：按天滚动写入 ~/.calamex/logs/calamex.<date>.log，保留最近 7 天，非阻塞写。
    // 任一步失败都降级为「仅 stderr」，绝不阻断启动。返回的 guard 必须存活至进程退出，
    // 否则后台写线程会被提前 drop、丢失缓冲日志。
    let log_dir = storage_paths::local_root().join("logs");
    let (file_layer, guard) = match std::fs::create_dir_all(&log_dir).ok().and_then(|_| {
        tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("calamex")
            .filename_suffix("log")
            .max_log_files(7)
            .build(&log_dir)
            .ok()
    }) {
        Some(file_appender) => {
            let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
            let layer = fmt::layer().with_ansi(false).with_writer(non_blocking);
            (Some(layer), Some(guard))
        }
        None => (None, None),
    };

    // env-filter 默认 info 级，可用 RUST_LOG 覆盖；try_init 会安装 tracing-log 桥接，
    // log::* 调用继续被捕获。失败（已有全局订阅者，如测试）时静默跳过。
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(file_layer)
        .try_init();

    guard
}`;
patch('init_tracing 文件滚动日志', oldInit, newInit, 'WorkerGuard');

// 4) 调用处保留 guard
patch('保留日志 guard',
  '\n    init_tracing();\n', '\n    let _tracing_guard = init_tracing();\n',
  'let _tracing_guard = init_tracing();');

// 5) single-instance 必须作为第一个插件
const builderHead =
`    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("favicon", |context, request, responder| {`;
const builderNew =
`    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 二次启动拦截：已有实例运行时，新进程（如双击关联文件）的启动参数回流到这里。
            // 显示主窗口并把待打开文件转发给前端，新进程随后自动退出，避免多开。
            reveal_main_window(app);
            emit_open_files(app, &argv);
        }))
        .register_asynchronous_uri_scheme_protocol("favicon", |context, request, responder| {`;
patch('single-instance 插件', builderHead, builderNew, 'tauri_plugin_single_instance::init');

// 6) window-state 插件（不含 VISIBLE，保持 visible:false 由代码控制）
const openerLine = '        .plugin(tauri_plugin_opener::init())\n';
patch('window-state 插件',
  openerLine + '        .manage(AiEditState::default())',
  openerLine +
`        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(AiEditState::default())`,
  'tauri_plugin_window_state::Builder');

// 7) 冷启动关联文件：延迟多次重发，规避前端监听器注册竞态（前端按路径去重）
const setupTail =
`                });
            }

            emit_startup_step("tauri.setup.done", app_started_at, setup_started_at);`;
const setupNew =
`                });
            }

            // 冷启动关联文件打开：进程首次启动（非二次实例）时，关联文件路径在 argv 中。
            // 前端事件监听器要等 Vue 挂载后才注册，存在竞态——此处延迟后按 [1500ms, 2500ms]
            // 重发，由前端按路径去重，确保「冷启动双击 .sh」必定打开对应文件。
            {
                let open_files_app = app.handle().clone();
                std::thread::spawn(move || {
                    let argv: Vec<String> = std::env::args().collect();
                    if extract_openable_files(&argv).is_empty() {
                        return;
                    }
                    for delay_ms in [1500_u64, 2500_u64] {
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        emit_open_files(&open_files_app, &argv);
                    }
                });
            }

            emit_startup_step("tauri.setup.done", app_started_at, setup_started_at);`;
patch('冷启动关联文件重发', setupTail, setupNew, 'let open_files_app = app.handle().clone();');

// 写回（还原原始换行风格）
const out = isCRLF ? s.replace(/\n/g, '\r\n') : s;
writeFileSync(join(ROOT, REL), out);

console.log(`\n目标：${join(ROOT, REL)}`);
console.log(`换行：${isCRLF ? 'CRLF（写回保持 CRLF）' : 'LF'}\n`);
console.log(log.join('\n'));
console.log('\n下一步：pnpm install  然后  pnpm tauri:build  本地验证编译与打包。');
if (hadError) { console.log('\n⚠ 仍有锚点未命中，说明该文件已被改过或与仓库版本不同，请把 main.rs 发我手动核对。'); process.exit(2); }
console.log('\nmain.rs 全部补好了。');