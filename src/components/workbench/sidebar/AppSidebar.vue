<template>
<aside class="app-sidebar-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden" :class="{ 'source-control-sidebar-host': isSourceControlView, 'explorer-sidebar-host': isExplorerView, 'search-sidebar-host': isSearchView, 'ssh-sidebar-host': isSshView, }" >
  <!-- 性能优化：所有侧边栏面板全常驻挂载，仅用 v-show 切换可见性，彻底避免切换时的 mount/unmount 与同步渲染开销。 各面板内部的数据加载仍由 is-active 等条件控制（例如仅在对应 view 激活时才加载/刷新），隐藏时不空跑。 -->
  <SourceControlPanel v-show="isSourceControlView" class="h-full min-h-0 w-full flex-1" :is-active="isSourceControlView" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :active-path="document.path" @open-file="handleOpenFile" @open-diff="handleOpenGitDiff" />
  <WorkspaceExplorerPanel v-show="isExplorerView" :document="document" :is-active="isExplorerView" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :preloaded-workspace-root="preloadedWorkspaceRoot" :startup-explorer-expanded-paths="startupExplorerExpandedPaths" :startup-explorer-selected-path="startupExplorerSelectedPath" @open-file="handleOpenFile" @open-folder="emit('open-folder')" @explorer-state-change="emit('explorer-state-change', $event)" />
  <SearchSidebarPanel v-show="isSearchView" :is-active="isSearchView" :document-path="document.path" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :preloaded-workspace-root="preloadedWorkspaceRoot" @open-file="handleOpenFile" />
  <RunSidebarPanel v-show="isRunView" :is-active="isRunView" />
  <div v-show="isSshView" class="ssh-sidebar-host-shell flex min-h-0 w-full flex-1 flex-col overflow-hidden" >
    <SshSidebarPanel :is-active="isSshView" @open-terminal="emit('open-terminal')" />
  </div>
  <!-- fallback placeholder (rare) -->
  <template v-if="!isExplorerView && !isSearchView && !isSourceControlView && !isRunView && !isSshView">
    <div class="border-b border-(--shell-divider) px-3 py-3"> <p class="sidebar-section-title" v-text="panelMeta.title"></p> </div>
    <div class="workbench-scroll-region min-h-0 flex-1 overflow-auto py-2">
      <div class="space-y-3 px-3 py-2">
        <section class="rounded-xl border border-(--border-subtle) bg-white/3 p-3">
          <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)"> 侧边栏页面 </p>
          <h3 class="mt-2 text-[13px] font-semibold text-(--text-primary)" v-text="panelMeta.headline"></h3>
          <p class="mt-2 text-[12px] leading-6 text-(--text-secondary)" v-text="panelMeta.description"></p>
          <div class="mt-3 flex items-center gap-2"> <Button variant="outline" size="sm"><span v-text="panelMeta.actionLabel"></span></Button> <span class="text-[11px] text-(--text-quaternary)">交互面板预留位</span> </div>
        </section>
        <section class="rounded-xl border border-(--border-subtle) bg-(--panel-muted)/50 p-3">
          <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-(--text-quaternary)"> 将展示 </p>
          <div class="mt-3 space-y-2">
            <article v-for="item in panelMeta.items" :key="item.title" class="rounded-lg border border-white/5 bg-white/3 px-3 py-2" >
              <p class="text-[12px] font-medium text-(--text-primary)" v-text="item.title"></p>
              <p class="mt-1 text-[11px] leading-5 text-(--text-secondary)" v-text="item.description"></p>
            </article>
          </div>
        </section>
      </div>
    </div>
  </template>
</aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import WorkspaceExplorerPanel from '@/components/workbench/sidebar/explorer/WorkspaceExplorerPanel.vue';
import RunSidebarPanel from '@/components/workbench/sidebar/run/RunSidebarPanel.vue';
import SearchSidebarPanel from '@/components/workbench/sidebar/search/SearchSidebarPanel.vue';
import SourceControlPanel from '@/components/workbench/sidebar/source-control/SourceControlPanel.vue';
import SshSidebarPanel from '@/components/workbench/sidebar/ssh/SshSidebarPanel.vue';
import type { TWorkbenchSidebarView } from '@/types/app';
import type {
  IActiveRunSummary,
  ICommandTemplate,
  IEditorDocument,
  IRunHistoryEntry,
  IWorkspaceDirectoryPayload,
  TExecutorKind,
  TWorkbenchOpenFilePayload,
} from '@/types/editor';
import type { IGitDiffPreviewRequest } from '@/types/git';

const props = defineProps<{
  document: IEditorDocument;
  view: TWorkbenchSidebarView;
  isDesktopRuntime: boolean;
  workspaceRootPath: string | null;
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;
  startupExplorerExpandedPaths: string[];
  startupExplorerSelectedPath: string | null;
  canRun: boolean;
  isRunning: boolean;
  hasRunArtifacts: boolean;
  activeRun: IActiveRunSummary | null;
  runHistory: IRunHistoryEntry[];
  commandTemplates: ICommandTemplate[];
  executor: TExecutorKind;
}>();

const emit = defineEmits<{
  'open-file': [payload: TWorkbenchOpenFilePayload];
  'open-folder': [];
  'open-git-diff': [payload: IGitDiffPreviewRequest];
  run: [];
  'create-document': [];
  'open-terminal': [];
  'insert-template': [template: ICommandTemplate];
  'clear-run-history': [];
  'explorer-state-change': [payload: { expandedPaths: string[]; selectedPath: string | null }];
}>();

const SIDEBAR_META: Record<
  TWorkbenchSidebarView,
  {
    title: string;
    headline: string;
    description: string;
    actionLabel: string;
    items: Array<{ title: string; description: string }>;
  }
> = {
  explorer: {
    title: '资源管理器',
    headline: '浏览工作区目录',
    description: '在这里查看脚本、图片资源和文件树。',
    actionLabel: '浏览文件',
    items: [],
  },
  search: {
    title: '搜索',
    headline: '全局搜索与快速定位',
    description: '后续可以在这里放置关键字、范围过滤和搜索结果列表。',
    actionLabel: '搜索面板',
    items: [
      { title: '全文匹配', description: '跨脚本搜索命令、变量、路径和注释。' },
      { title: '范围过滤', description: '限定目录、文件类型和忽略规则。' },
      { title: '结果联动', description: '搜索结果可直接定位到编辑器标签。' },
    ],
  },
  'source-control': {
    title: '源代码管理',
    headline: '变更、暂存与提交',
    description: '后续可以在这里聚合当前工作区的 Git 状态与常用操作。',
    actionLabel: '版本控制',
    items: [
      { title: '变更列表', description: '按文件展示未提交、已暂存和冲突状态。' },
      { title: '提交入口', description: '输入提交说明并触发常用 Git 动作。' },
      { title: '分支提示', description: '显示当前分支和同步状态。' },
    ],
  },
  run: {
    title: '运行',
    headline: '执行配置与流程入口',
    description: '后续可以把运行配置、快速命令和运行历史收拢到这一栏。',
    actionLabel: '运行配置',
    items: [
      { title: '启动脚本', description: '预置常用执行模板和参数组合。' },
      { title: '调试入口', description: '为脚本运行和终端回放留出调试位。' },
      { title: '历史记录', description: '回看最近一次运行的命令和结果。' },
    ],
  },
  ai: {
    title: 'AI 助手',
    headline: '对话、解释与修复建议',
    description: '这里承载 AI 对话、上下文整理和模型配置入口。',
    actionLabel: '打开 AI 面板',
    items: [
      { title: '对话框', description: '用于向模型提问、整理上下文和保留临时对话。' },
      { title: '快捷任务', description: '解释脚本、修复报错、代码审查等高频入口。' },
      { title: '服务配置', description: '配置模型服务地址、模型名和系统提示词。' },
    ],
  },
  extensions: {
    title: 'SSH 连接',
    headline: '远端连接与文件传输',
    description: '这里承载 SSH 会话、远端文件浏览和传输任务。',
    actionLabel: '连接远端',
    items: [
      { title: '连接表单', description: '填写主机、端口、用户和认证方式。' },
      { title: '远端文件', description: '查看当前路径、文件列表和选中状态。' },
      { title: '传输任务', description: '追踪上传下载进度并保留后续操作位。' },
    ],
  },
};

const isExplorerView = computed(() => props.view === 'explorer');
const isSearchView = computed(() => props.view === 'search');
const isSourceControlView = computed(() => props.view === 'source-control');
const isRunView = computed(() => props.view === 'run');
const isSshView = computed(() => props.view === 'extensions');
const panelMeta = computed(() => SIDEBAR_META[props.view] ?? SIDEBAR_META.ai);

const handleOpenFile = (payload: TWorkbenchOpenFilePayload): void => {
  emit('open-file', payload);
};
const handleOpenGitDiff = (payload: IGitDiffPreviewRequest): void => {
  emit('open-git-diff', payload);
};
</script>
