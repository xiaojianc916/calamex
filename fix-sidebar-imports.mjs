// fix-sidebar-imports.mjs —— 仓库根目录运行：node fix-sidebar-imports.mjs
// 把所有指向「已搬到 sidebar/ 子目录的旧扁平路径」的 import 自动重新指向新位置
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const SIDEBAR_ROOT = "src/components/workbench/sidebar";

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p.replace(/\\/g, "/"));
  }
  return acc;
}

// 建立「文件名 -> sidebar 下的新别名路径」索引
const byBase = new Map();
for (const p of walk(SIDEBAR_ROOT)) {
  if (!p.endsWith(".vue")) continue;
  const base = p.split("/").pop();
  const alias = "@/" + p.replace(/^src\//, "");
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(alias);
}

const RE = /@\/components\/workbench\/([^/'"]+)\.vue/g;
const files = walk(SRC).filter((p) => /\.(vue|ts|mts|tsx)$/.test(p));

let changed = 0;
let warned = false;

for (const file of files) {
  const before = readFileSync(file, "utf8");
  const hits = [];
  const after = before.replace(RE, (full, name) => {
    const flat = `src/components/workbench/${name}.vue`;
    if (existsSync(flat)) return full; // 根目录仍存在，合法，跳过
    const candidates = byBase.get(`${name}.vue`) || [];
    if (candidates.length === 1) {
      hits.push(`${name}.vue -> ${candidates[0]}`);
      return candidates[0];
    }
    if (candidates.length === 0) {
      console.error(`✗ 找不到替代位置：${file} 引用 ${name}.vue`);
    } else {
      console.error(`✗ 有多个同名候选，需手动确认：${file} 引用 ${name}.vue\n    ${candidates.join("\n    ")}`);
    }
    warned = true;
    return full;
  });
  if (after !== before) {
    writeFileSync(file, after, "utf8");
    changed++;
    console.log(`✓ ${file}\n    ${hits.join("\n    ")}`);
  }
}

console.log(`\n共修改 ${changed} 个文件。`);
if (warned) {
  console.error("有未能自动处理的引用（见上），先别提交，把输出贴给我。");
  process.exit(1);
} else {
  console.log("接着执行：git add -A && git commit --no-edit && git push origin main");
}