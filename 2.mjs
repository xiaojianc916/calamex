#!/usr/bin/env node
// @ts-check
/**
 * P2 迁移:移除 CopilotKit / AG-UI 第二管线(前端)。
 * 配合《Calamex AI 管线统一与 ACP 化重构方案》P2 阶段。
 *
 * 特性:默认 dry-run(仅预演),加 --write 才落盘;锚点式替换 + 唯一性校验;
 *       幂等(已应用步骤自动跳过);锚点缺失即报错中止,绝不静默改坏。
 *
 * 用法(仓库根目录):
 *   node scripts/p2-remove-copilotkit.mjs            # 预演
 *   node scripts/p2-remove-copilotkit.mjs --write     # 落盘 + 删除
 *
 * 前置:先 git pull 拿到 useCopilotSuggestions 去耦合提交(84250cf)。
 */
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const WRITE = process.argv.includes('--write');
const ROOT = process.cwd();
const rel = (p) => resolve(ROOT, p);

const PANEL = 'src/components/business/ai/shell/AiAssistantPanel.vue';
const SHELL = 'src/views/ShellWorkbenchView.vue';

let changed = 0;
let skipped = 0;
const errors = [];

function del(path, label, snippet) {
  const file = rel(path);
  if (!existsSync(file)) { errors.push(`缺文件: ${path}`); return; }
  const text = readFileSync(file, 'utf8');
  const count = text.split(snippet).length - 1;
  if (count === 0) { console.log(`  · 跳过(已删除) ${path} :: ${label}`); skipped++; return; }
  if (count > 1) { errors.push(`锚点非唯一(x${count}): ${path} :: ${label}`); return; }
  if (WRITE) writeFileSync(file, text.replace(snippet, ''));
  console.log(`  ✓ ${WRITE ? '已删除' : '将删除'} ${path} :: ${label}`);
  changed++;
}

function replace(path, label, from, to) {
  const file = rel(path);
  if (!existsSync(file)) { errors.push(`缺文件: ${path}`); return; }
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) {
    if (text.includes(to)) { console.log(`  · 跳过(已应用) ${path} :: ${label}`); skipped++; return; }
    errors.push(`锚点缺失: ${path} :: ${label}`); return;
  }
  const count = text.split(from).length - 1;
  if (count > 1) { errors.push(`锚点非唯一(x${count}): ${path} :: ${label}`); return; }
  if (WRITE) writeFileSync(file, text.replace(from, to));
  console.log(`  ✓ ${WRITE ? '已改' : '将改'} ${path} :: ${label}`);
  changed++;
}

function removeFile(path) {
  const file = rel(path);
  if (!existsSync(file)) { console.log(`  · 跳过(已删) ${path}`); skipped++; return; }
  if (WRITE) rmSync(file, { recursive: true, force: true });
  console.log(`  ✓ ${WRITE ? '已删除' : '将删除'} ${path}`);
  changed++;
}

function editPackageJson() {
  const path = 'package.json';
  const file = rel(path);
  if (!existsSync(file)) { errors.push(`缺文件: ${path}`); return; }
  const drop = new Set(['@ag-ui/client', '@ag-ui/core', '@copilotkit/core', '@copilotkit/vue']);
  const has = (obj) => obj && [...drop].some((k) => obj[k] !== undefined);
  const original = readFileSync(file, 'utf8');
  const before = JSON.parse(original);
  if (!has(before.dependencies) && !has(before.devDependencies)) {
    console.log('  · 跳过(已应用) package.json :: 4 个依赖已移除'); skipped++; return;
  }
  const next = original
    .split('\n')
    .filter((line) => {
      const m = line.match(/^\s*"([^"]+)"\s*:\s*"/);
      return !(m && drop.has(m[1]));
    })
    .join('\n');
  let after;
  try { after = JSON.parse(next); } catch (e) { errors.push(`package.json 删后非法 JSON: ${e.message}`); return; }
  if (has(after.dependencies) || has(after.devDependencies)) { errors.push('package.json 仍残留目标依赖'); return; }
  if (WRITE) writeFileSync(file, next);
  console.log(`  ✓ ${WRITE ? '已改' : '将改'} package.json :: 移除 @ag-ui/client, @ag-ui/core, @copilotkit/core, @copilotkit/vue`);
  changed++;
}

function scanResidual() {
  const tokens = ['@copilotkit', '@ag-ui', '@/copilotkit', 'useCopilotContext', 'useFrontendTool'];
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
      if (!/\.(ts|tsx|vue|js|mjs)$/.test(name)) continue;
      const text = readFileSync(full, 'utf8');
      for (const t of tokens) if (text.includes(t)) hits.push(`${full.replace(ROOT + '/', '')}  ←  ${t}`);
    }
  };
  walk(rel('src'));
  return hits;
}

console.log(`\n=== P2 移除 CopilotKit / AG-UI 第二管线  [${WRITE ? '落盘' : 'dry-run 预演'}] ===\n`);

// 1) AiAssistantPanel.vue —— 删 3 个 import + 死钩子调用块
del(PANEL, 'import useFrontendTool', "import { useFrontendTool } from '@copilotkit/vue';\n");
del(PANEL, 'import z (仅 useFrontendTool 用)', "import { z } from 'zod';\n");
del(PANEL, 'import useCopilotContext', "import { useCopilotContext } from '@/composables/ai/useCopilotContext';\n");
del(PANEL, 'useCopilotContext() + useFrontendTool 死钩子', `
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
`);

// 2) ShellWorkbenchView.vue —— 拆 Provider 包裹层 + 删懒加载/预取
replace(SHELL, '模板:去掉 Provider 包裹,v-if 下放到 Surface',
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
            />`);

replace(SHELL, '脚本:删 DeferredCopilotKitProvider 懒加载定义',
`// CopilotKit 运行时(含 @copilotkit/vue)改为按需懒加载:仅当进入/固定 AI 工作区时
// 才加载,并作为 AI 子树的上下文 Provider 挂载,使「首屏为编辑器」时彻底不进入启动关键路径。
const DeferredCopilotKitProvider = defineAsyncComponent({
  loader: () => import('@/copilotkit/provider/CopilotKitProvider.vue'),
  suspensible: false,
});

const DeferredRunPanel = defineAsyncComponent({`,
`const DeferredRunPanel = defineAsyncComponent({`);

replace(SHELL, '脚本:空闲预取去掉 Provider 一行 + 改注释',
`// AI 工作区与 CopilotKit 运行时:改为「浏览器空闲时」后台预热,既保留首次切到 AI 模式
// 时无空白帧的体验,又不在启动关键路径上与首帧争抢主线程/带宽(原先是模块求值期同步
// 触发的 import,会和首屏渲染竞争)。
const prefetchAiSurfaceWhenIdle = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const prefetch = (): void => {
    void import('@/copilotkit/provider/CopilotKitProvider.vue');
    void import('@/components/business/ai/shell/AiWorkspaceSurface.vue');
  };`,
`// AI 工作区:改为「浏览器空闲时」后台预热,既保留首次切到 AI 模式时无空白帧的体验,又不在
// 启动关键路径上与首帧争抢主线程/带宽(原先是模块求值期同步触发的 import,会和首屏渲染竞争)。
const prefetchAiSurfaceWhenIdle = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const prefetch = (): void => {
    void import('@/components/business/ai/shell/AiWorkspaceSurface.vue');
  };`);

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
    console.log('\n✓ 残留扫描通过:src 下已无 @copilotkit / @ag-ui / useCopilotContext / useFrontendTool 引用。');
  }
}

console.log(`\n小结:变更 ${changed} 处,跳过 ${skipped} 处,错误 ${errors.length} 处。`);
if (errors.length) {
  console.error('\n✗ 存在错误,未完成:');
  for (const e of errors) console.error(`    - ${e}`);
  process.exit(1);
}
console.log(WRITE ? '\n✓ 落盘完成。请运行门禁:pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm guard' : '\n(dry-run) 确认无误后加 --write 落盘。');