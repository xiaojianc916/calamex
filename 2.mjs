// 4.mjs —— 统一 GitHub 登录 pill 注入方式 + 修复 ahead/behind 显示
// 在仓库根目录(D:\com.xiaojianc\my_desktop_app)运行: node 4.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');

const PANEL = 'src/components/workbench/sidebar/source-control/SourceControlPanel.vue';
const MAIN = 'src/app/main.ts';
const DELETE_REL = 'src/domains/git/utils/github-auth-header.ts';

// ── 工具：CRLF 安全的精确替换 ────────────────────────────────
function stageEdits(relPath, edits) {
  const abs = path.join(ROOT, relPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const usesCRLF = raw.includes('\r\n');
  let text = usesCRLF ? raw.replace(/\r\n/g, '\n') : raw;

  for (const [i, { find, replace }] of edits.entries()) {
    const hits = text.split(find).length - 1;
    if (hits !== 1) {
      throw new Error(`✘ [${relPath}] 第 ${i + 1} 处替换预期命中 1 次，实际 ${hits} 次。已中止，未写入任何文件。`);
    }
    text = text.split(find).join(replace);
  }
  return { abs, content: usesCRLF ? text.replace(/\n/g, '\r\n') : text };
}

// ── 0) 动手前：确认没有别处引用该模块 ────────────────────────
function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|vue)$/.test(name)) acc.push(p);
  }
  return acc;
}
const deleteAbs = path.join(ROOT, DELETE_REL);
const mainAbs = path.join(ROOT, MAIN);
const strays = walk(SRC).filter((p) => p !== deleteAbs && p !== mainAbs)
  .filter((p) => /github-auth-header|GitHubAuthHeaderEnhancement/.test(fs.readFileSync(p, 'utf8')))
  .map((p) => path.relative(ROOT, p));
if (strays.length) {
  console.error('✘ 还有其它文件引用了该模块，已中止（请先处理）：\n  ' + strays.join('\n  '));
  process.exit(1);
}

try {
  // ── 1) SourceControlPanel.vue：修 bug + 直接放组件 + 补 import ──
  const panel = stageEdits(PANEL, [
    {
      find: `import { computed, ref, watch } from 'vue';\nimport { useDialog } from '@/composables/useDialog';`,
      replace: `import { computed, ref, watch } from 'vue';\nimport GitHubAuthPill from '@/components/workbench/GitHubAuthPill.vue';\nimport { useDialog } from '@/composables/useDialog';`,
    },
    {
      find: `<span v-if="status.behind > 0">↓  status.behind </span>`,
      replace: `<span v-if="status.behind > 0">↓  status.behind </span>`,
    },
    {
      find: `<span v-if="status.ahead > 0">↑  status.ahead </span>`,
      replace: `<span v-if="status.ahead > 0">↑  status.ahead </span>`,
    },
    {
      find: `<span v-if="status.ahead === 0 && status.behind === 0" v-text="workspaceStateLabel" />\n        </div>`,
      replace: `<span v-if="status.ahead === 0 && status.behind === 0" v-text="workspaceStateLabel" />\n          <GitHubAuthPill :repository-root-path="status.repositoryRootPath" />\n        </div>`,
    },
  ]);

  // ── 2) main.ts：移除 import + 调用 ───────────────────────────
  const main = stageEdits(MAIN, [
    {
      find: `import { initGitHubAuthHeaderEnhancement } from '@/domains/git/utils/github-auth-header';\n`,
      replace: ``,
    },
    {
      find: `    initGitHubAuthHeaderEnhancement();\n    initEditorScrollbarActivity();`,
      replace: `    initEditorScrollbarActivity();`,
    },
  ]);

  // ── 3) 落盘前最终校验 ────────────────────────────────────────
  if (/initGitHubAuthHeaderEnhancement|github-auth-header/.test(main.content)) {
    throw new Error('✘ main.ts 仍残留对该模块的引用，已中止。');
  }
  if (!panel.content.includes('GitHubAuthPill')) {
    throw new Error('✘ 面板未成功插入 GitHubAuthPill，已中止。');
  }
  if (!fs.existsSync(deleteAbs)) {
    throw new Error(`✘ 待删除文件不存在：${DELETE_REL}（可能已迁移过），已中止。`);
  }

  // ── 全部成功，统一写入 ───────────────────────────────────────
  fs.writeFileSync(panel.abs, panel.content, 'utf8');
  fs.writeFileSync(main.abs, main.content, 'utf8');
  fs.rmSync(deleteAbs);

  console.log('✔ 完成：');
  console.log('  · 修复 SourceControlPanel.vue 的 ahead/behind 显示（插值缺失）');
  console.log('  · GitHubAuthPill 改为直接子组件，删除 MutationObserver 注入');
  console.log(`  · 已删除 ${DELETE_REL}`);
  console.log('\n下一步请跑：pnpm typecheck && pnpm lint && pnpm test && pnpm build');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}