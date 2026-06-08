// scripts/refactor-scm-panel.mjs
// 用途：将 SourceControlPanel.vue 的 4 个 tab 面板抽离为子组件，并清理已迁出的脚本符号。
// 特性：幂等（已改过则跳过）、锚点校验、失败即中止（不写坏文件）、原子写入、自动识别 EOL。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findTarget() {
  if (process.argv[2]) {
    return path.resolve(process.argv[2].endsWith('.vue')
      ? process.argv[2]
      : path.join(process.argv[2], 'src/components/workbench/SourceControlPanel.vue'));
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = path.join(dir, 'src/components/workbench/SourceControlPanel.vue');
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error('找不到 SourceControlPanel.vue，请把仓库根目录或文件路径作为参数传入。');
}

const target = findTarget();
const raw = fs.readFileSync(target, 'utf8');

// 幂等：已经引入子组件就说明改过了
if (raw.includes('SourceControlHistoryTab')) {
  console.log('已检测到 SourceControlHistoryTab，文件已是重构后状态，跳过。');
  process.exit(0);
}

const usesCRLF = raw.includes('\r\n');
let content = usesCRLF ? raw.replace(/\r\n/g, '\n') : raw;

// ---- 工具函数（任何不匹配都抛错，main 里统一捕获并中止）----
function replaceOnce(label, from, to) {
  const i = content.indexOf(from);
  if (i === -1) throw new Error(`未找到待替换片段：${label}`);
  if (content.indexOf(from, i + from.length) !== -1) throw new Error(`片段不唯一：${label}`);
  content = content.slice(0, i) + to + content.slice(i + from.length);
}
function removeOnce(label, snippet) {
  replaceOnce(label, snippet, '');
}
function cutBetween(label, startAnchor, endAnchor) {
  const s = content.indexOf(startAnchor);
  if (s === -1) throw new Error(`未找到起始锚点：${label}`);
  const e = content.indexOf(endAnchor, s + startAnchor.length);
  if (e === -1) throw new Error(`未找到结束锚点：${label}`);
  content = content.slice(0, s) + content.slice(e); // 保留 endAnchor
}

try {
  // ===== 1. import 调整 =====
  replaceOnce(
    'vue import 去掉 nextTick',
    `import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';`,
    `import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';`,
  );
  replaceOnce(
    'GitHistoryGraph -> 4 个子组件',
    `import GitHistoryGraph from '@/components/workbench/GitHistoryGraph.vue';`,
    [
      `import SourceControlBranchesTab from '@/components/workbench/source-control/SourceControlBranchesTab.vue';`,
      `import SourceControlHistoryTab from '@/components/workbench/source-control/SourceControlHistoryTab.vue';`,
      `import SourceControlPullRequestsTab from '@/components/workbench/source-control/SourceControlPullRequestsTab.vue';`,
      `import SourceControlStashTab from '@/components/workbench/source-control/SourceControlStashTab.vue';`,
    ].join('\n'),
  );
  removeOnce('类型 IGitPullRequestDetailPayload', `  IGitPullRequestDetailPayload,\n`);

  // ===== 2. 顶部 refs：分支创建相关 =====
  removeOnce(
    '分支创建 refs',
    `const isBranchCreateOpen = ref(false);\n` +
      `const branchCreateName = ref('');\n` +
      `const branchCreateError = ref<string | null>(null);\n` +
      `const branchNameInputRef = ref<HTMLInputElement | null>(null);\n`,
  );

  // ===== 3. promptForText（仅被已迁出的 handleSaveStash 使用）=====
  removeOnce(
    'promptForText',
    `const promptForText = (title: string, defaultValue = ''): string | null => {\n` +
      `  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {\n` +
      `    return null;\n` +
      `  }\n\n` +
      `  return window.prompt(title, defaultValue);\n` +
      `};\n\n`,
  );

  // ===== 4. 已迁出的 loading 标志（单行）=====
  removeOnce('isCommitHistoryLoading', `const isCommitHistoryLoading = computed(() => gitStore.isCommitHistoryLoading);\n`);
  removeOnce('isBranchesLoading', `const isBranchesLoading = computed(() => gitStore.isBranchesLoading);\n`);
  removeOnce('isStashesLoading', `const isStashesLoading = computed(() => gitStore.isStashesLoading);\n`);
  removeOnce('isPullRequestsLoading', `const isPullRequestsLoading = computed(() => gitStore.isPullRequestsLoading);\n`);

  // ===== 5. 大段删除（锚点区间，保留 KEEP 符号）=====
  // isPullRequestSupportLoading / isSettingRemote / 远程表单 / TPullRequestView  ——> 直到 pullRequests(保留)
  cutBetween(
    'PR 支持标志 + 远程表单 + TPullRequestView',
    `const isPullRequestSupportLoading = computed(() => gitStore.isPullRequestSupportLoading);`,
    `const pullRequests = computed<IGitPullRequestSummaryPayload[]>(() => gitStore.pullRequests);`,
  );
  // pullRequestDetail / PR 视图状态 / 全部 PR 处理函数  ——> 直到 sections(保留)
  cutBetween(
    'PR detail + 视图状态 + 处理函数',
    `const pullRequestDetail = computed<IGitPullRequestDetailPayload | null>(`,
    `const sections = computed<IGitSection[]>(() => {`,
  );
  // matchesSearchQuery / filtered* / 各面板标题文案 / stash watch  ——> 直到 resolveEntryKind(保留)
  cutBetween(
    'filtered* + 面板文案 + stash watch',
    `const matchesSearchQuery = (parts: Array<string | null | undefined>): boolean => {`,
    `const resolveEntryKind = (`,
  );
  // 历史/分支/贮藏/PR 的 reload 与操作处理函数  ——> 直到右键菜单 useSourceControlContextMenu(保留)
  cutBetween(
    'reload/branch/stash/remote 处理函数',
    `const handleReloadCommitHistory = async (): Promise<void> => {`,
    `const {\n  buildRepositoryMenuGroups,`,
  );

  // ===== 6. 两个 watcher 收尾 =====
  replaceOnce(
    'workspaceRootPath watcher 去掉已删变量重置',
    `    sourceControlActionError.value = null;\n` +
      `    activeStashId.value = undefined;\n` +
      `    isRemoteFormOpen.value = false;\n` +
      `    remoteFormError.value = null;\n` +
      `    pullRequestView.value = 'list';\n` +
      `    activePullRequestNumber.value = null;\n` +
      `    closeSourceControlMenu();\n`,
    `    sourceControlActionError.value = null;\n` +
      `    closeSourceControlMenu();\n`,
  );
  replaceOnce(
    'activeTab watcher 去掉 pull-requests 重置块',
    `  (nextTab) => {\n` +
      `    if (nextTab === 'pull-requests') {\n` +
      `      pullRequestView.value = 'list';\n` +
      `      activePullRequestNumber.value = null;\n` +
      `    }\n\n` +
      `    if (!hasRepository.value || nextTab === 'changes') {\n`,
    `  (nextTab) => {\n` +
      `    if (!hasRepository.value || nextTab === 'changes') {\n`,
  );

  // ===== 7. 模板：4 个 tab 面板 -> 子组件标签（用滚动容器收尾 div 作为右边界）=====
  const tplStart = `        <section v-else-if="activeTab === 'history'" class="source-control-info-panel source-control-history-panel">`;
  const startIdx = content.indexOf(tplStart);
  if (startIdx === -1) throw new Error('未找到模板起点：history 面板 <section>');
  const footerIdx = content.indexOf(`      <footer v-if="activeTab === 'changes'" class="source-control-commit">`);
  if (footerIdx === -1) throw new Error('未找到模板锚点：changes footer');
  const scrollCloseIdx = content.lastIndexOf('\n      </div>', footerIdx) + 1; // 指向 source-control-scroll 的收尾 </div>
  if (scrollCloseIdx <= startIdx) throw new Error('模板边界异常：scroll 收尾 </div> 未定位到 history 之后');

  const childTags =
    `        <SourceControlHistoryTab v-else-if="activeTab === 'history'" :search-query="searchQuery" :is-busy="isBusy" />\n\n` +
    `        <SourceControlBranchesTab v-else-if="activeTab === 'branches'" :search-query="searchQuery"\n` +
    `          :is-busy="isBusy" :run-with-pending="runWithPending" />\n\n` +
    `        <SourceControlPullRequestsTab v-else-if="activeTab === 'pull-requests'" :is-busy="isBusy"\n` +
    `          :run-with-pending="runWithPending" />\n\n` +
    `        <SourceControlStashTab v-else :search-query="searchQuery" :is-busy="isBusy"\n` +
    `          :run-with-pending="runWithPending" />\n`;

  content = content.slice(0, startIdx) + childTags + content.slice(scrollCloseIdx);

  // ===== 8. 折叠多余空行（Biome 最多 1 个空行）=====
  content = content.replace(/\n{3,}/g, '\n\n');

  // ===== 写回（原子 + 还原 EOL）=====
  const out = usesCRLF ? content.replace(/\n/g, '\r\n') : content;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, target);
  console.log(`已重构：${target}`);
  console.log('请运行 pnpm lint && pnpm typecheck 核对。');
} catch (err) {
  console.error(`已中止，未改动文件：${err.message}`);
  process.exit(1);
}