// fix-lint-hygiene.mjs
// #7：删除 src/store/git.ts 中未使用的 consola 导入。
// #8：useShellWorkbenchView.ts 复用 math.clamp，去掉手写 min/max。
// 均幂等 + 锚点校验，git 可回滚。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const GIT_STORE = 'src/store/git.ts';
const SHELL_VIEW = 'src/composables/useShellWorkbenchView.ts';

for (const f of [GIT_STORE, SHELL_VIEW]) {
  if (!existsSync(f)) {
    console.error(`未找到 ${f}，请在仓库根目录运行。`);
    process.exit(1);
  }
}

const replaceOnce = (src, oldStr, newStr, label) => {
  const count = src.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`[${label}] 锚点匹配 ${count} 次（期望 1），中止。`);
    process.exit(1);
  }
  return src.replace(oldStr, newStr);
};

// ---- #7: git.ts 删除未使用的 consola 导入 ----
let git = readFileSync(GIT_STORE, 'utf8');
if (git.includes("import { consola } from 'consola';")) {
  git = replaceOnce(git, "import { consola } from 'consola';\n", '', 'git consola import');
  writeFileSync(GIT_STORE, git, 'utf8');
  console.log('OK：git.ts 已移除未使用的 consola 导入。');
} else {
  console.log('跳过：git.ts 无 consola 导入（幂等）。');
}

// ---- #8: useShellWorkbenchView.ts 复用 math.clamp ----
let view = readFileSync(SHELL_VIEW, 'utf8');
if (view.includes("from '@/utils/core/math'")) {
  console.log('跳过：useShellWorkbenchView.ts 已复用 math.clamp（幂等）。');
} else {
  view = replaceOnce(
    view,
    "import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';\n",
    "import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';\nimport { clamp } from '@/utils/core/math';\n",
    'view import',
  );
  view = replaceOnce(
    view,
    `  const clampAiPanelWidth = (value: number): number =><br>    Math.min(AI_PANEL_MAX_WIDTH, Math.max(AI_PANEL_MIN_WIDTH, Math.round(value)));`,
    `  const clampAiPanelWidth = (value: number): number =><br>    clamp(Math.round(value), AI_PANEL_MIN_WIDTH, AI_PANEL_MAX_WIDTH);`,
    'view clampAiPanelWidth',
  );
  writeFileSync(SHELL_VIEW, view, 'utf8');
  console.log('OK：useShellWorkbenchView.ts 已复用 math.clamp。');
}

console.log('完成。请运行：pnpm lint && pnpm typecheck && pnpm test');