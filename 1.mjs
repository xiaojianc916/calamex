// 2.mjs —— 摘掉 useAiAssistant.ts 里已失效的 ISidecarAnswerStreamState import
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const REL = 'src/composables/ai/useAiAssistant.ts';
const p = path.join(process.cwd(), REL);
let s = fs.readFileSync(p, 'utf8');

const n = (s.match(/\bISidecarAnswerStreamState\b/g) || []).length;
console.log(`\n== 摘 ISidecarAnswerStreamState import ${APPLY ? '【APPLY】' : '【DRY-RUN】'} ==`);
console.log(`  当前文件中出现次数：${n}（应为 1，仅 import 行）`);

if (n !== 1) {
  console.log('  🛑 出现次数不是 1，已中止。把本输出贴回来，我看具体上下文。\n');
  process.exit(1);
}

// 从 import 列表里移除该标识符：相邻逗号两侧都在则留一个逗号，否则一并去掉
const next = s.replace(/(,\s*)?ISidecarAnswerStreamState(\s*,)?/, (_m, a, b) => (a && b ? ',' : ''));

if (next === s) { console.log('  🛑 未发生替换，已中止。\n'); process.exit(1); }
console.log('  ✓ 已从 import 列表移除');

if (!APPLY) { console.log('\n✅ dry-run 通过。执行：node 2.mjs --apply\n'); process.exit(0); }

fs.writeFileSync(p + '.step3b.bak', s);
fs.writeFileSync(p, next, 'utf8');
console.log(`\n✅ 已写入 ${REL}（备份 ${REL}.step3b.bak）\n`);