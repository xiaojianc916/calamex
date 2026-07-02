// scripts/y1-unify-time-source.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const FILE = 'src-tauri/src/commands/terminal/events.rs';
let src = readFileSync(FILE, 'utf8');

const OLD_FN = `fn terminal_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}`;
const NEW_FN = `fn terminal_now_ms() -> i64 {
    // 统一走 jiff（与本模块 finished_at 同源），消除同文件两套时钟口径。
    jiff::Timestamp::now().as_millisecond()
}`;
if (!src.includes(OLD_FN)) throw new Error('未找到 terminal_now_ms 目标实现，请人工核对（jiff API 名以本仓库版本为准）。');
src = src.replace(OLD_FN, NEW_FN);

// 清理不再使用的 SystemTime/UNIX_EPOCH import（若无其它引用）
if (!/SystemTime|UNIX_EPOCH/.test(src.replace(/use std::\{[^}]*\};/, ''))) {
  src = src.replace(/\n\s*time::\{SystemTime, UNIX_EPOCH\},?/, '');
}
writeFileSync(FILE, src);
console.log('✅ Y1: 时间源已统一到 jiff。请 cargo check 确认 jiff API 名与 import。');