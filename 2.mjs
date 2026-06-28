#!/usr/bin/env node
// fix-host-sink-clone.mjs
// perf(acp): borrow session_id in EventSink instead of cloning twice per frame
// sink 是每条 session/update 帧的下沉口（每个 token 增量都过），原代码无条件 clone 两次
// Option<String> 仅为 peek；改为 as_deref 借用，只在确有一次性命令/配置帧落缓存时才 to_string。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'src-tauri', 'src', 'acp', 'host.rs');

const OLD = `            // 先按「原始 ACP 会话 id」捕获 available_commands_update 的 availableCommands 原始数组，
            // 缓存供回合发起时以前端键重放（取键须在重写 session_id 之前，键须为 ACP 会话 UUID）。
            if let Some(acp_session_id) = frame.session_id.clone() {
                if let Some(commands) = extract_available_commands_update(&frame.event) {
                    commands_cache_for_sink
                        .lock()
                        .insert(acp_session_id, commands);
                }
            }

            // 与可用命令同构：按原始 ACP 会话 id 捕获 config_option_update 的 configOptions 原始数组，
            // 缓存供回合发起时以前端键重放（取键须在重写 session_id 之前）。
            if let Some(acp_session_id) = frame.session_id.clone() {
                if let Some(config_options) = extract_config_option_update(&frame.event) {
                    config_options_cache_for_sink
                        .lock()
                        .insert(acp_session_id, config_options);
                }
            }`;

const NEU = `            // 先按「原始 ACP 会话 id」捕获一次性下发的 available_commands_update / config_option_update，
            // 缓存供回合发起时以前端键重放（取键须在重写 session_id 之前，键须为 ACP 会话 UUID）。
            // 以 as_deref 借用避免每帧（含纯文本增量帧）对 session_id 的两次冗余 String 克隆——
            // 仅在确有一次性命令/配置帧命中、需要落缓存时才 to_string。
            if let Some(acp_session_id) = frame.session_id.as_deref() {
                if let Some(commands) = extract_available_commands_update(&frame.event) {
                    commands_cache_for_sink
                        .lock()
                        .insert(acp_session_id.to_string(), commands);
                }
                if let Some(config_options) = extract_config_option_update(&frame.event) {
                    config_options_cache_for_sink
                        .lock()
                        .insert(acp_session_id.to_string(), config_options);
                }
            }`;

async function main() {
  let raw;
  try {
    raw = await readFile(FILE, 'utf8');
  } catch (err) {
    console.error(`✗ 读取失败：${err.message}`);
    process.exit(1);
  }
  const crlf = raw.includes('\r\n');
  let lf = raw.replaceAll('\r\n', '\n');

  if (lf.includes('= frame.session_id.as_deref() {')) {
    console.log('• 已是最新：host.rs sink 已采用借用语义，无需修改');
    return;
  }

  const first = lf.indexOf(OLD);
  if (first === -1) {
    console.error('✗ 锚点未匹配，跳过（未写入）：host.rs sink 双 clone 块');
    process.exit(1);
  }
  if (lf.indexOf(OLD, first + OLD.length) !== -1) {
    console.error('✗ 锚点出现多次，保守中止（未写入）');
    process.exit(1);
  }
  lf = lf.replace(OLD, NEU);

  // 自检：旧的每帧 clone 必须消失；新借用 + 落缓存 to_string 必须出现。
  if (
    lf.includes('frame.session_id.clone()') ||
    !lf.includes('= frame.session_id.as_deref() {') ||
    !lf.includes('.insert(acp_session_id.to_string(), commands)') ||
    !lf.includes('.insert(acp_session_id.to_string(), config_options)')
  ) {
    console.error('✗ 自检失败，放弃写入（未改动任何文件）');
    process.exit(1);
  }

  await writeFile(FILE, crlf ? lf.replaceAll('\n', '\r\n') : lf, 'utf8');
  console.log('✓ 已修复：host.rs sink 改为 as_deref 借用，消除每帧两次冗余 session_id 克隆');
}

main().catch((err) => {
  console.error(`✗ 执行失败：${err.message}`);
  process.exit(1);
});