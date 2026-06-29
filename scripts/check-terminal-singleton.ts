/**
 * check-terminal-singleton.ts
 * 扫描 `new Terminal(` 出现位置，白名单仅允许在 terminal session 模块中（R-18.4.1 / R-20.2.1）
 *
 * T-2.3 完成后白名单仅 src/domains/terminal/core/session.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { CheckResult, printResult, ROOT, summarize } from './guard-utils.js';

/** 允许创建 Terminal 实例的白名单（相对路径，正斜杠） */
const WHITELIST = [
  'src/domains/terminal/core/session.ts', // T-2.3 后的唯一合法位置（R-18.4.1 / R-20.2.1）
];

const NEW_TERMINAL_RE = /new\s+Terminal\s*\(/g;

function walkFor(dir: string, pattern: RegExp, callback: (rel: string, lineNo: number) => void) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d)) {
      const full = path.join(d, entry);
      if (fs.statSync(full).isDirectory()) {
        // 跳过 node_modules / target / dist
        if (['node_modules', 'target', 'dist', '.git'].includes(entry)) continue;
        walk(full);
      } else if (entry.endsWith('.ts') || entry.endsWith('.vue')) {
        const content = fs.readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            callback(path.relative(ROOT, full).replace(/\\/g, '/'), idx + 1);
          }
        });
        pattern.lastIndex = 0; // reset global regex
      }
    }
  };
  walk(abs);
}

const results: CheckResult[] = [];

walkFor('src', NEW_TERMINAL_RE, (relPath, lineNo) => {
  const normalizedWhiteList = WHITELIST.map((w) => w.replace(/\\/g, '/'));
  if (normalizedWhiteList.includes(relPath)) {
    results.push({
      severity: 'PASS',
      message: `new Terminal( 在白名单文件中（行 ${lineNo}）`,
      file: relPath,
    });
  } else {
    results.push({
      severity: 'ERROR',
      message: `非法的 new Terminal( 实例化（行 ${lineNo}）`,
      file: relPath,
      detail: 'xterm Terminal 实例只允许在 terminal session 模块中创建（R-18.4.1 / R-20.2.1）',
    });
  }
});

if (results.length === 0) {
  results.push({ severity: 'PASS', message: '未发现非法 new Terminal( 调用' });
}

results.forEach(printResult);
const hasError = summarize('check-terminal-singleton', results);
process.exit(hasError ? 1 : 0);
