#!/usr/bin/env node
// @ts-check
// VSCode ts(7006) 是 @ts-check 静态提示，不影响 node 执行，可安心忽略。
/**
 * P2 迁移:移除 CopilotKit / AG-UI 第二管线(前端)。
 * 配合《Calamex AI 管线统一与 ACP 化重构方案》P2 阶段。
 *
 * 特性:默认 dry-run(仅预演),加 --write 才落盘;锚点式匹配 + 唯一性校验;
 *       行尾自适应(CRLF/LF 均可,写回保持原行尾);幂等;错误即中止。
 *
 * 用法(仓库根目录):
 *   node scripts/p2-remove-copilotkit.mjs            # 预演
 *   node scripts/p2-remove-copilotkit.mjs --write     # 落盘 + 删除
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = process.cwd();
const rel = (p) => resolve(ROOT, p);

const PANEL = 'src/components/business/ai/shell/AiAssistantPanel.vue';
const SHELL = 'src/views/ShellWorkbenchView.vue';

let changed = 0;
let skipped = 0;
const errors = [];

function read(file) {
  const raw = readFileSync(file, 'utf8');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  return { norm: raw.replace(/\r\n/g, '\n'), eol };
}
function save(file, norm, eol) {
  writeFileSync(file, eol === '\n' ? norm : norm.replace(/\n/g, eol));
}

function del(path, label, snippet) {
  const file = rel(path);
  if (!existsSync(file)) {
    errors.push(`缺文件: ${path}`);
    return;
  }
  const { norm, eol } = read(file);
  const count = norm.split(snippet).length - 1;
  if (count === 0) {
    console.log(`  · 跳过(已删除) ${path} :: ${label}`);
    skipped++;
    return;
  }
  if (count > 1) {
    errors.push(`锚点非唯一(x${count}): ${path} :: ${label}`);
    return;
  }
  if (WRITE) save(file, norm.replace(snippet, ''), eol);
  console.log(`  ✓ ${WRITE ? '已删除' : '将删除'} ${path} :: ${label}`);
  changed++;
}

function replace(path, label, from, to, goneMarker) {
  const file = rel(path);
  if (!existsSync(file)) {
    errors.push(`缺文件: ${path}`);
    return;
  }
  const { norm, eol } = read(file);
  if (!norm.includes(from)) {
    if (goneMarker && norm.includes(goneMarker)) {
      errors.push(`锚点漂移(残留「${goneMarker}」): ${path} :: ${label}`);
      return;
    }
    console.log(`  · 跳过(已应用) ${path} :: ${label}`);
    skipped++;
    return;
  }
  const count = norm.split(from).length - 1;
  if (count > 1) {
    errors.push(`锚点非唯一(x${count}): ${path} :: ${label}`);
    return;
  }
  if (WRITE) save(file, norm.replace(from, to), eol);
  console.log(`  ✓ ${WRITE ? '已改' : '将改'} ${path} :: ${label}`);
  changed++;
}

function removeFile(path) {
  const file = rel(path);
  if (!existsSync(file)) {
    console.log(`  · 跳过(已删) ${path}`);
    skipped++;
    return;
  }
  if (WRITE) rmSync(file, { recursive: true, force: true });
  console.log(`  ✓ ${WRITE ? '已删除' : '将删除'} ${path}`);
  changed++;
}

function editPackageJson() {
  const path = 'package.json';
  const file = rel(path);
  if (!existsSync(file)) {
    errors.push(`缺文件: ${path}`);
    return;
  }
  const drop = new Set(['@ag-ui/client', '@ag-ui/core', '@copilotkit/core', '@copilotkit/vue']);
  const has = (obj) => obj && [...drop].some((k) => obj[k] !== undefined);
  const { norm, eol } = read(file);
  const before = JSON.parse(norm);
  if (!has(before.dependencies) && !has(before.devDependencies)) {
    console.log('  · 跳过(已应用) package.json :: 4 个依赖已移除');
    skipped++;
    return;
  }
  const next = norm
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*"([^"]+)"\s*:\s*"/);
      return !(m && drop.has(m[1]));
    })
    .join('\n');
  let after;
  try {
    after = JSON.parse(next);
  } catch (e) {
    errors.push(`package.json 删后非法 JSON: ${e.message}`);
    return;
  }
  if (has(after.dependencies) || has(after.devDependencies)) {
    errors.push('package.json 仍残留目标依赖');
    return;
  }
  if (WRITE) save(file, next, eol);
  console.log(
    `  ✓ ${WRITE ? '已改' : '将改'} package.json :: 移除 @ag-ui/client, @ag-ui/core, @copilotkit/core, @copilotkit/vue`,
  );
  changed++;
}

function scanResidual() {
  const tokens = ['@copilotkit', '@ag-ui', '@/copilotkit', 'useCopilotContext', 'useFrontendTool'];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules') walk(full);
        continue;
      }
      if (!/\.(ts|tsx|vue|js|mjs)$/.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const t of tokens) if (text.includes(t)) hits.push(`${relative(ROOT, full)}  ←  ${t}`);
    }
  };
  walk(rel('src'));
  return hits;
}

console.log(
  `\n=== P2 移除 CopilotKit / AG-UI 第二管线  [${WRITE ? '落盘' : 'dry-run 预演'}] ===\n`,
);

// 1) AiAssistantPanel.vue
del(PANEL, 'import useFrontendTool', "import { useFrontendTool } from '@copilotkit/vue';\n");
del(PANEL, 'import z (仅 useFrontendTool 用)', "import { z } from 'zod';\n");
del(
  PANEL,
  'import useCopilotContext',
  "import { useCopilotContext } from '@/composables/ai/useCopilotContext';\n",
);
del(
  PANEL,
  'useCopilotContext() + useFrontendTool 死钩子',
  `
useCopilotContext({
  document: documentRef,
  activeRun: activeRunRef,
  analysis: analysisRef,
  selection: selectionRef,
  gitStatus: gitStatusRef,
  workspaceRootPath: workspaceRootPathRef,
});

try {
  useFrontendTool({ name: '*', parameters: z.looseObject({}), handler: async () => 'ok' });
} catch {
  /* provider not ready */
}
`,
);

// 2) ShellWorkbenchView.vue —— 模板包裹层
replace(
  SHELL,
  '模板:去掉 Provider 包裹,v-if 下放到 Surface',
  `            <DeferredCopilotKitProvider v-if="isAiMode || hasPinnedAiWorkspace">
              <DeferredAiWorkspaceSurface
                v-show="isAiMode"
                class="min-w-0 flex-1"
                :aria-hidden="!isAiMode"
                :document="editorStore.document"
                :active-run="editorStore.activeRunSummary"
                :analysis="editorStore.activeScriptAnalysis"
                :selection="editorStore.activeSelectionSummary"
                :git-status="gitStore.status"
                :workspace-root-path="editorStore.workspaceRootPath"
                @open-patch-diff="openGitDiffPreviewPayload"
              />
            </DeferredCopilotKitProvider>`,
  `            <DeferredAiWorkspaceSurface
              v-if="isAiMode || hasPinnedAiWorkspace"
              v-show="isAiMode"
              class="min-w-0 flex-1"
              :aria-hidden="!isAiMode"
              :document="editorStore.document"
              :active-run="editorStore.activeRunSummary"
              :analysis="editorStore.activeScriptAnalysis"
              :selection="editorStore.activeSelectionSummary"
              :git-status="gitStore.status"
              :workspace-root-path="editorStore.workspaceRootPath"
              @open-patch-diff="openGitDiffPreviewPayload"
            />`,
  '<DeferredCopilotKitProvider',
);

// ShellWorkbenchView.vue —— 脚本 S2: 删注释（全角标点匹原文）+ 删代码块（纯 ASCII）
del(
  SHELL,
  'CopilotKit 懒加载注释（2行）',
  '// CopilotKit 运行时（含 @copilotkit/vue）改为按需懒加载：仅当进入/固定 AI 工作区时\n// 才加载，并作为 AI 子树的上下文 Provider 挂载，使「首屏为编辑器」时彻底不进入启动关键路径。\n',
);
del(
  SHELL,
  'const DeferredCopilotKitProvider 代码块',
  "const DeferredCopilotKitProvider = defineAsyncComponent({\n  loader: () => import('@/copilotkit/provider/CopilotKitProvider.vue'),\n  suspensible: false,\n});\n\n",
);

// ShellWorkbenchView.vue —— 脚本 S3: 删注释（全角标点匹原文）+ 删 prefetch 里的 Provider import 行
del(
  SHELL,
  'AI 工作区预取注释（3行）',
  '// AI 工作区与 CopilotKit 运行时：改为「浏览器空闲时」后台预热，既保留首次切到 AI 模式\n// 时无空白帧的体验，又不在启动关键路径上与首帧争抢主线程/带宽（原先是模块求值期同步\n// 触发的 import，会和首屏渲染竞争）。\n',
);
del(
  SHELL,
  'prefetch 里的 CopilotKit Provider import 行',
  "    void import('@/copilotkit/provider/CopilotKitProvider.vue');\n",
);

// 3) 删除整个 src/copilotkit/ + useCopilotContext.ts
removeFile('src/copilotkit');
removeFile('src/composables/ai/useCopilotContext.ts');

// 4) package.json 删 4 依赖
editPackageJson();

// 5) 残留扫描(落盘且无错时执行)
if (WRITE && errors.length === 0) {
  const hits = scanResidual();
  if (hits.length) {
    console.log('\n⚠ 仍检测到 CopilotKit/AG-UI 残留引用(请确认已 pull 到 suggestions 去耦合提交):');
    for (const h of hits) console.log(`    - ${h}`);
    errors.push(`残留引用 ${hits.length} 处`);
  } else {
    console.log(
      '\n✓ 残留扫描通过:src 下已无 @copilotkit / @ag-ui / useCopilotContext / useFrontendTool 引用。',
    );
  }
}

console.log(`\n小结:变更 ${changed} 处,跳过 ${skipped} 处,错误 ${errors.length} 处。`);
if (errors.length) {
  console.error('\n✗ 存在错误,未完成:');
  for (const e of errors) console.error(`    - ${e}`);
  process.exit(1);
}
console.log(
  WRITE
    ? '\n✓ 落盘完成。请运行门禁:pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm guard'
    : '\n(dry-run) 确认无误后加 --write 落盘。',
);
