// 1.mjs — Step 7.4d 文档纠偏：修正 entriesMirrorBridge.ts 过时注释（双写已接线 + soak 中）
// 用法: node 1.mjs        实际写入
//      node 1.mjs --check 仅校验匹配、不写盘
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK = process.argv.includes('--check');

const read = (rel) => readFileSync(resolve(REPO_ROOT, rel), 'utf8');
const write = (rel, next) => {
  if (CHECK) {
    console.log(`[check] would write ${rel} (${next.length} bytes)`);
    return;
  }
  writeFileSync(resolve(REPO_ROOT, rel), next);
  console.log(`[write] ${rel} (${next.length} bytes)`);
};

/** 唯一子串替换；命中数必须 === 1，否则抛错（绝不静默误改/漏改）。 */
const replaceOnce = (src, oldStr, newStr) => {
  const idx = src.indexOf(oldStr);
  if (idx < 0) throw new Error(`replaceOnce: 未找到目标子串:\n${oldStr}`);
  if (src.indexOf(oldStr, idx + oldStr.length) >= 0) {
    throw new Error(`replaceOnce: 目标子串出现多次，拒绝替换:\n${oldStr}`);
  }
  return src.slice(0, idx) + newStr + src.slice(idx + oldStr.length);
};

const FILE = 'src/store/aiThread/entriesMirrorBridge.ts';

const OLD =
  '便于单测且与具体实现解耦。真实接线 (main.ts) 留待 7.4d; 本模块当前未被引用。';
const NEW =
  '便于单测且与具体实现解耦。真实接线见 main.ts (Step 7.4d): 在 legacy hydrate 与读侧' +
  '回退槽填充 (runStartupPersistedRead) 之后调用 installEntriesMirror, 故 entries 新 key' +
  '当前处于双写 + 双读 soak 阶段 (legacy 持久化仍权威, 渲染 SoT 不变)。';

const src = read(FILE);
if (src.includes(NEW)) {
  console.log('[skip] 注释已是最新，无需改动');
} else {
  write(FILE, replaceOnce(src, OLD, NEW));
}

console.log(CHECK ? '[done] check 通过' : '[done] 已更新');