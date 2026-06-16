// scripts/add-explorer-indent-guides.mjs
// 为文件树（explorer）添加缩进竖线 indent guides。
// 修改两处：
//   1. src/components/workbench/sidebar/explorer/WorkspaceTreeRow.vue
//   2. src/styles/sidebar-explorer.css
// 用法：在仓库根目录执行 `node scripts/add-explorer-indent-guides.mjs`
// 特性：幂等（已改过则跳过）、锚点不匹配则报错中止、不写备份文件。

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();

const VUE_PATH = resolve(
  ROOT,
  'src/components/workbench/sidebar/explorer/WorkspaceTreeRow.vue',
);
const CSS_PATH = resolve(ROOT, 'src/styles/sidebar-explorer.css');

/** 统计子串出现次数 */
function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

async function patchFile(path, label, transform) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`读取失败 [${label}] ${path}: ${err.message}`);
  }

  const result = transform(source);

  if (result.skipped) {
    console.log(`• 跳过 [${label}]：${result.reason}`);
    return false;
  }

  await writeFile(path, result.content, 'utf8');
  console.log(`✓ 已修改 [${label}]：${result.note}`);
  return true;
}

// ---------- 1) WorkspaceTreeRow.vue ----------
// 在两个 entry 分支的 .explorer-chevron 之前插入缩进竖线。
const CHEVRON_ANCHOR =
  '    <span class="explorer-chevron" :class="{ \'is-placeholder\': !row.showChevron }">';

const GUIDE_TEMPLATE = `    <span
      v-for="i in row.level"
      :key="\`guide-\${i}\`"
      class="explorer-indent-guide"
      :style="{ left: \`\${32 + (i - 1) * 18}px\` }"
      aria-hidden="true"
    />

`;

function transformVue(source) {
  if (source.includes('explorer-indent-guide')) {
    return { skipped: true, reason: '已存在 explorer-indent-guide，无需重复插入' };
  }

  const occurrences = countOccurrences(source, CHEVRON_ANCHOR);
  if (occurrences !== 2) {
    throw new Error(
      `WorkspaceTreeRow.vue: 期望命中 chevron 锚点 2 次，实际 ${occurrences} 次。` +
        '文件可能已变动，请人工核对锚点后再运行。',
    );
  }

  const content = source.split(CHEVRON_ANCHOR).join(GUIDE_TEMPLATE + CHEVRON_ANCHOR);
  return { skipped: false, content, note: `已在 ${occurrences} 个 entry 分支插入缩进竖线模板` };
}

// ---------- 2) sidebar-explorer.css ----------
const CSS_ANCHOR =
  '.explorer-tree-row {\n  padding-left: calc(8px + var(--explorer-indent, 0px));\n}';

const CSS_REPLACEMENT = `.explorer-tree-row {
  position: relative;
  padding-left: calc(8px + var(--explorer-indent, 0px));
}

.explorer-indent-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--shell-divider) 55%, transparent);
  pointer-events: none;
}`;

function transformCss(source) {
  if (source.includes('.explorer-indent-guide')) {
    return { skipped: true, reason: '已存在 .explorer-indent-guide 规则，无需重复添加' };
  }

  const occurrences = countOccurrences(source, CSS_ANCHOR);
  if (occurrences !== 1) {
    throw new Error(
      `sidebar-explorer.css: 期望命中 .explorer-tree-row 锚点 1 次，实际 ${occurrences} 次。` +
        '文件可能已变动，请人工核对锚点后再运行。',
    );
  }

  const content = source.replace(CSS_ANCHOR, CSS_REPLACEMENT);
  return {
    skipped: false,
    content,
    note: '已加 position: relative 并追加 .explorer-indent-guide 规则',
  };
}

// ---------- 执行 ----------
async function main() {
  console.log('开始添加 explorer 缩进竖线…\n');

  let changed = 0;
  changed += (await patchFile(VUE_PATH, 'WorkspaceTreeRow.vue', transformVue)) ? 1 : 0;
  changed += (await patchFile(CSS_PATH, 'sidebar-explorer.css', transformCss)) ? 1 : 0;

  console.log(
    changed === 0
      ? '\n完成：无改动（可能已应用过）。'
      : `\n完成：共修改 ${changed} 个文件。`,
  );
}

main().catch((err) => {
  console.error(`\n✗ 中止：${err.message}`);
  process.exitCode = 1;
});