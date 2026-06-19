// fix-batch5-escapeRegExp.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';

const projectRoot = argv[2] ?? process.cwd();
const filePath = join(projectRoot, 'src/services/ipc/ai.service.ts');
const content = readFileSync(filePath, 'utf8');

// 删除本地 escapeRegExp 声明行（第 80 行附近）
// 匹配: const escapeRegExp = (value: string): string => value.replace(...);
const lines = content.split('\n');
const filtered = lines.filter(line => {
  // 匹配本地声明的 escapeRegExp，但不匹配 import 行
  if (/^\s*const\s+escapeRegExp\s*=/.test(line)) {
    return false;
  }
  return true;
});

writeFileSync(filePath, filtered.join('\n'), 'utf8');
console.log('Done. Removed local escapeRegExp declaration from ai.service.ts');