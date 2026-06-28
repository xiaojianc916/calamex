#!/usr/bin/env node
// fix-uievent-move-acpupdate.mjs
// perf(acp): move ACP update into ui_event instead of clone-then-drop on the stream hot path
// 把 session_notification_to_ui_event 改为消费 Value（take ownership），tool_call(_update) arm
// 用 std::mem::take 移动 update，消除每帧对 rawInput/rawOutput 的深拷贝。输出字节级一致。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const UI = path.join(ROOT, 'src-tauri', 'src', 'acp', 'ui_event.rs');
const RUNTIME = path.join(ROOT, 'src-tauri', 'src', 'acp', 'runtime.rs');

const Q = '"'; // 仅为可读性

// ui_event.rs 的定点替换（LF 归一后匹配）
const UI_EDITS = [
  {
    name: 'tool_call_ui_event 改为接收 owned Value',
    old:
`fn tool_call_ui_event(kind: &str, update: &Value) -> Value {
    json!({ ${Q}type${Q}: kind, ${Q}acpUpdate${Q}: update.clone() })
}`,
    neu:
`fn tool_call_ui_event(kind: &str, update: Value) -> Value {
    json!({ ${Q}type${Q}: kind, ${Q}acpUpdate${Q}: update })
}`,
  },
  {
    name: 'session_notification_to_ui_event 改为消费 Value',
    old:
`pub fn session_notification_to_ui_event(notification: &Value) -> Option<Value> {
    let update = notification.get(${Q}update${Q})?;
    let kind = update.get(${Q}sessionUpdate${Q}).and_then(Value::as_str)?;
    match kind {`,
    neu:
`pub fn session_notification_to_ui_event(mut notification: Value) -> Option<Value> {
    let update = notification.get_mut(${Q}update${Q})?;
    let kind = update.get(${Q}sessionUpdate${Q}).and_then(Value::as_str)?.to_owned();
    match kind.as_str() {`,
  },
  {
    name: 'tool_call arm 改为 std::mem::take 移动',
    old:
`        ${Q}tool_call${Q} | ${Q}tool_call_update${Q} => Some(tool_call_ui_event(kind, update)),`,
    neu:
`        ${Q}tool_call${Q} | ${Q}tool_call_update${Q} => {
            let owned_update = std::mem::take(update);
            Some(tool_call_ui_event(&kind, owned_update))
        }`,
  },
];

const CALL_OLD = 'session_notification_to_ui_event(&';
const CALL_NEW = 'session_notification_to_ui_event(';

function applyExact(content, old, neu, label) {
  const first = content.indexOf(old);
  if (first === -1) return { ok: false, content };
  if (content.indexOf(old, first + old.length) !== -1) {
    throw new Error(`锚点出现多次，保守中止：${label}`);
  }
  return { ok: true, content: content.replace(old, neu) };
}

async function loadLF(file) {
  const raw = await readFile(file, 'utf8');
  return { raw, crlf: raw.includes('\r\n'), lf: raw.replaceAll('\r\n', '\n') };
}

function dump(lf, crlf) {
  return crlf ? lf.replaceAll('\n', '\r\n') : lf;
}

async function main() {
  let ui;
  let rt;
  try {
    ui = await loadLF(UI);
    rt = await loadLF(RUNTIME);
  } catch (err) {
    console.error(`✗ 读取失败：${err.message}`);
    process.exit(1);
  }

  // 幂等
  if (ui.lf.includes('mut notification: Value') && ui.lf.includes('std::mem::take(update)')) {
    console.log('• 已是最新：ui_event.rs 已采用移动语义，无需修改');
    return;
  }

  let uiNext = ui.lf;
  for (const edit of UI_EDITS) {
    const res = applyExact(uiNext, edit.old, edit.neu, edit.name);
    if (!res.ok) {
      console.error(`✗ 锚点未匹配，跳过（未写入任何文件）：${edit.name}`);
      process.exit(1);
    }
    uiNext = res.content;
  }
  // 测试调用点：去掉传引用的 &（消费 owned）
  const uiCallCount = uiNext.split(CALL_OLD).length - 1;
  uiNext = uiNext.replaceAll(CALL_OLD, CALL_NEW);

  // runtime.rs 的唯一非测试调用点
  const rtCallCount = rt.lf.split(CALL_OLD).length - 1;
  if (rtCallCount === 0) {
    console.error('✗ runtime.rs 未找到 session_notification_to_ui_event(&...) 调用，保守中止（未写入）');
    process.exit(1);
  }
  const rtNext = rt.lf.replaceAll(CALL_OLD, CALL_NEW);

  // 自检：旧 clone / 旧借用签名必须消失；新签名 / take 必须出现
  if (
    uiNext.includes('update.clone()') ||
    uiNext.includes('notification: &Value') ||
    uiNext.includes(CALL_OLD) ||
    rtNext.includes(CALL_OLD) ||
    !uiNext.includes('mut notification: Value') ||
    !uiNext.includes('std::mem::take(update)')
  ) {
    console.error('✗ 自检失败，放弃写入（未改动任何文件）');
    process.exit(1);
  }

  await writeFile(UI, dump(uiNext, ui.crlf), 'utf8');
  await writeFile(RUNTIME, dump(rtNext, rt.crlf), 'utf8');
  console.log(
    `✓ 已修复：ui_event.rs（${UI_EDITS.length} 处定点 + ${uiCallCount} 处测试调用）` +
      ` & runtime.rs（${rtCallCount} 处调用）→ tool_call 帧改为移动语义，消除每帧深拷贝`,
  );
}

main().catch((err) => {
  console.error(`✗ 执行失败：${err.message}`);
  process.exit(1);
});