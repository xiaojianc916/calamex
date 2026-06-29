// 7.mjs — 删除 terminal-run.ts 中不可达的 legacy 标题兼容层（Finding D）
// 证据：run 日志唯一生产者 runOrchestrator 恒带 code+scope:'run'；editor store
// persist 仅 pick ['sessionSnapshot']，runLogs/runHistory 从不写盘回读，故按
// 本地化 UI 文案兜底分类的分支对任何真实数据不可达 => 兼容层，按 SOP 移除。
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/domains/terminal/utils/terminal-run.ts';

const die = (msg) => {
  console.error(`\u2718 ${msg}`);
  process.exit(1);
};

const raw = readFileSync(FILE, 'utf8');
const usesCRLF = raw.includes('\r\n');
let src = usesCRLF ? raw.replace(/\r\n/g, '\n') : raw;

const replaceOnce = (content, find, replace, label) => {
  const parts = content.split(find);
  if (parts.length !== 2) {
    die(`[${label}] 预期命中 1 次，实际 ${parts.length - 1} 次，已中止且未写入。`);
  }
  return parts.join(replace);
};

// 预检：确保还没被改过
if (!src.includes('LEGACY_RUN_FLOW_LOG_TITLES')) {
  die('未找到待清理的 legacy 集合，文件可能已处理过，已中止。');
}

const edits = [
  {
    label: '删除两个 legacy 标题集合',
    find:
`const LEGACY_RUN_FLOW_LOG_TITLES = new Set([
  TERMINAL_RUN_LOG_TITLES.start,
  TERMINAL_RUN_LOG_TITLES.dispatched,
  TERMINAL_RUN_LOG_TITLES.tempFile,
  TERMINAL_RUN_LOG_TITLES.completed,
  TERMINAL_RUN_LOG_TITLES.failed,
  '终端执行状态异常',
  '脚本执行失败',
]);

const LEGACY_FINAL_RUN_LOG_TITLES = new Set([
  TERMINAL_RUN_LOG_TITLES.completed,
  TERMINAL_RUN_LOG_TITLES.failed,
  '终端执行状态异常',
  '脚本执行失败',
]);

`,
    replace: '',
  },
  {
    label: 'isTerminalRunStartLog 收敛为纯 code',
    find:
`export const isTerminalRunStartLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.start || item.title === TERMINAL_RUN_LOG_TITLES.start;`,
    replace:
`export const isTerminalRunStartLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.start;`,
  },
  {
    label: 'isTerminalRunDispatchedLog 收敛为纯 code',
    find:
`export const isTerminalRunDispatchedLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.dispatched ||
  item.title === TERMINAL_RUN_LOG_TITLES.dispatched;`,
    replace:
`export const isTerminalRunDispatchedLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.dispatched;`,
  },
  {
    label: 'isTerminalRunTempFileLog 收敛为纯 code',
    find:
`const isTerminalRunTempFileLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.tempFile || item.title === TERMINAL_RUN_LOG_TITLES.tempFile;`,
    replace:
`const isTerminalRunTempFileLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.tempFile;`,
  },
  {
    label: 'isTerminalRunCompletedLog 收敛为纯 code',
    find:
`export const isTerminalRunCompletedLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.completed ||
  item.title === TERMINAL_RUN_LOG_TITLES.completed;`,
    replace:
`export const isTerminalRunCompletedLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.completed;`,
  },
  {
    label: 'isTerminalRunTimeoutLog 收敛为纯 code',
    find:
`export const isTerminalRunTimeoutLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.timeout || item.title === TERMINAL_RUN_LOG_TITLES.timeout;`,
    replace:
`export const isTerminalRunTimeoutLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.timeout;`,
  },
  {
    label: 'isTerminalRunFailedLog 收敛为纯 code',
    find:
`export const isTerminalRunFailedLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.failed ||
  item.title === TERMINAL_RUN_LOG_TITLES.failed ||
  item.title === '终端执行状态异常' ||
  item.title === '脚本执行失败';`,
    replace:
`export const isTerminalRunFailedLog = (item: Pick<IRunLogEntry, 'title' | 'code'>): boolean =>
  item.code === TERMINAL_RUN_LOG_CODES.failed;`,
  },
  {
    label: 'isTerminalRunFlowLog 去掉标题兜底',
    find:
`export const isTerminalRunFlowLog = (item: IRunLogEntry): boolean =>
  item.scope === 'run' ||
  (typeof item.code === 'string' && TERMINAL_RUN_LOG_CODE_SET.has(item.code)) ||
  LEGACY_RUN_FLOW_LOG_TITLES.has(item.title);`,
    replace:
`export const isTerminalRunFlowLog = (item: IRunLogEntry): boolean =>
  item.scope === 'run' ||
  (typeof item.code === 'string' && TERMINAL_RUN_LOG_CODE_SET.has(item.code));`,
  },
  {
    label: 'isTerminalRunFinalLog 去掉标题兜底',
    find:
`export const isTerminalRunFinalLog = (item: IRunLogEntry): boolean =>
  (typeof item.code === 'string' && TERMINAL_RUN_FINAL_LOG_CODE_SET.has(item.code)) ||
  LEGACY_FINAL_RUN_LOG_TITLES.has(item.title);`,
    replace:
`export const isTerminalRunFinalLog = (item: IRunLogEntry): boolean =>
  typeof item.code === 'string' && TERMINAL_RUN_FINAL_LOG_CODE_SET.has(item.code);`,
  },
];

for (const e of edits) {
  src = replaceOnce(src, e.find, e.replace, e.label);
}

// 后置守卫：确认兼容层痕迹已彻底清除，且关键能力仍在
const mustGone = [
  'LEGACY_RUN_FLOW_LOG_TITLES',
  'LEGACY_FINAL_RUN_LOG_TITLES',
  'item.title',
  '\u7ec8\u7aef\u6267\u884c\u72b6\u6001\u5f02\u5e38', // 终端执行状态异常
  '\u811a\u672c\u6267\u884c\u5931\u8d25', // 脚本执行失败
];
for (const tok of mustGone) {
  if (src.includes(tok)) die(`后置守卫失败：清理后仍残留 [${tok}]，已中止。`);
}
const mustKeep = [
  'TERMINAL_RUN_LOG_CODE_SET',
  'TERMINAL_RUN_FINAL_LOG_CODE_SET',
  'TERMINAL_RUN_LOG_TITLES', // 仍作为 title 文案来源导出
  'item.code === TERMINAL_RUN_LOG_CODES.failed;',
];
for (const tok of mustKeep) {
  if (!src.includes(tok)) die(`后置守卫失败：意外丢失 [${tok}]，已中止。`);
}

const out = usesCRLF ? src.replace(/\n/g, '\r\n') : src;
writeFileSync(FILE, out, 'utf8');
console.log('\u2714 terminal-run.ts legacy 标题兼容层已移除（9 处编辑全部命中）。');