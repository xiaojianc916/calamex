// diagnose.mjs — 打印实际文件片段诊断匹配失败原因
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const dump = (target, anchor, before = 80, after = 300) => {
  const filePath = join(root, target);
  if (!existsSync(filePath)) {
    console.log(`\n===== ${target} — NOT FOUND =====`);
    return;
  }
  const raw = readFileSync(filePath, 'utf8');
  const idx = raw.indexOf(anchor);
  if (idx === -1) {
    console.log(`\n===== ${target} — anchor "${anchor}" NOT FOUND =====`);
    // 打印前 2000 字符帮助诊断
    console.log(raw.slice(0, 2000));
    return;
  }
  const start = Math.max(0, idx - before);
  const end = Math.min(raw.length, idx + after);
  const snippet = raw.slice(start, end);
  // 用 JSON.stringify 让不可见字符（\r \n \t）可见
  console.log(`\n===== ${target} — anchor found at ${idx} =====`);
  console.log(JSON.stringify(snippet));
};

// 1. session.ts — 找 encodeTerminalInputForDiagnostics
dump('src/terminal/session.ts', 'encodeTerminalInputForDiagnostics');

// 2. themes/runtime/manager.ts — 找 addEventListener
dump('src/themes/runtime/manager.ts', 'addEventListener');

// 3. useShellWorkbenchView.ts — 找 terminalHeight
dump('src/composables/useShellWorkbenchView.ts', 'terminalHeight');

// 4. aiEdit.ts — 找 setPin 里的 map
dump('src/store/aiEdit.ts', 'timelineEntries.value = timelineEntries.value.map');