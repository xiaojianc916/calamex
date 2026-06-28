#!/usr/bin/env node
// fix-autoapply-operation-clone.mjs
// perf(aed): move operation payloads into the timeline instead of cloning them again.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = path.join(process.cwd(), 'src-tauri', 'src', 'ai', 'edit', 'apply', 'auto_apply.rs');

const EDITS = [
  { // 1) 调用点：按值传入（move）
    old: 'record_committed_operations(state, &operation_payloads)?;',
    neu: 'record_committed_operations(state, operation_payloads)?;',
  },
  { // 2) 函数签名：&[..] → Vec<..>
    old: `fn record_committed_operations(
    state: &AiEditState,
    operations: &[AiEditOperationPayload],
) -> Result<(), String> {`,
    neu: `fn record_committed_operations(
    state: &AiEditState,
    operations: Vec<AiEditOperationPayload>,
) -> Result<(), String> {`,
  },
  { // 3) 函数体：iter().cloned() → into_iter()
    old: `    guard.extend(
        operations
            .iter()
            .cloned()
            .map(AiEditTimelineEntryPayload::Operation),
    );`,
    neu: `    guard.extend(
        operations
            .into_iter()
            .map(AiEditTimelineEntryPayload::Operation),
    );`,
  },
];

function applyExact(text, old, neu, label) {
  const first = text.indexOf(old);
  if (first === -1) return { text, status: 'missing' };
  if (text.indexOf(old, first + old.length) !== -1) return { text, status: 'ambiguous' };
  return { text: text.replace(old, neu), status: 'ok' };
}

async function main() {
  let raw;
  try { raw = await readFile(FILE, 'utf8'); }
  catch (err) { console.error(`✗ 读取失败：${err.message}`); process.exit(1); }
  const crlf = raw.includes('\r\n');
  let lf = raw.replaceAll('\r\n', '\n');

  if (lf.includes('operations: Vec<AiEditOperationPayload>,') &&
      lf.includes('record_committed_operations(state, operation_payloads)?;')) {
    console.log('• 已是最新：operation 列表已 move 进时间线'); return;
  }

  for (let i = 0; i < EDITS.length; i++) {
    const { old, neu } = EDITS[i];
    const r = applyExact(lf, old, neu);
    if (r.status !== 'ok') {
      console.error(`✗ 第 ${i + 1} 处锚点${r.status === 'missing' ? '未匹配' : '不唯一'}，放弃写入（未改动任何文件）`);
      process.exit(1);
    }
    lf = r.text;
  }

  // 自检
  if (lf.includes('record_committed_operations(state, &operation_payloads)') ||
      lf.includes('operations: &[AiEditOperationPayload],') ||
      lf.includes('.iter()\n            .cloned()\n            .map(AiEditTimelineEntryPayload::Operation)') ||
      !lf.includes('operations\n            .into_iter()\n            .map(AiEditTimelineEntryPayload::Operation)')) {
    console.error('✗ 自检失败，放弃写入（未改动任何文件）'); process.exit(1);
  }

  await writeFile(FILE, crlf ? lf.replaceAll('\n', '\r\n') : lf, 'utf8');
  console.log('✓ 已修复：record_committed_operations 接管所有权，省掉每次写盘的整表 operation 克隆');
}
main().catch((err) => { console.error(`✗ 执行失败：${err.message}`); process.exit(1); });