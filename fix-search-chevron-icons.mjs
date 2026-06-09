// fix-search-chevron-icons.mjs
// 把搜索面板的 ▸/▾ 三角箭头替换为 lucide chevron 图标。
// 用法：放到项目根目录后运行 `node fix-search-chevron-icons.mjs`，跑完可删。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(ROOT, 'src/components/workbench/SearchSidebarPanel.vue');

// 匹配 v-text="<条件> ? '▸' : '▾'"
// \u25B8 = ▸（折叠态）  \u25BE = ▾（展开态）
const PATTERN = /v-text="([^"]*?)\s*\?\s*'\u25B8'\s*:\s*'\u25BE'"/g;
const REPLACEMENT =
  `:class="$1 ? 'icon-[lucide--chevron-right]' : 'icon-[lucide--chevron-down]'"`;
const EXPECTED = 3;

const source = readFileSync(TARGET, 'utf8');
const found = (source.match(PATTERN) ?? []).length;

if (found !== EXPECTED) {
  console.error(`✗ 预期 ${EXPECTED} 处三角箭头，实际找到 ${found} 处，已中止（未写入）。`);
  process.exit(1);
}

writeFileSync(TARGET, source.replace(PATTERN, REPLACEMENT), 'utf8');
console.log(`✓ 已替换 ${found} 处 → lucide chevron：${TARGET}`);