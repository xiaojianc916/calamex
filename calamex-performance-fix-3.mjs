#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => writeFileSync(join(root, file), content, 'utf8');
const lines = (items) => `${items.join('\n')}\n`;

const replaceOnce = (file, source, target, label) => {
  const content = read(file);
  const count = content.split(source).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${label} expected 1 match, got ${count}`);
  }
  write(file, content.replace(source, target));
  console.log(`updated ${file}: ${label}`);
};

// 1) 侧边栏面板：保留“访问后常驻”的体验，但不要在启动/首次进入时一次性挂载
//    SourceControl/Search/Run/SSH。v-show 会让所有异步面板立即实例化，隐藏面板里的
//    immediate watch / store 订阅 / composable 初始化也会跑，首屏和模式切换会被放大。
const appSidebarFile = 'src/components/workbench/sidebar/AppSidebar.vue';

replaceOnce(
  appSidebarFile,
  lines([
    "import { computed, defineAsyncComponent } from 'vue';",
  ]),
  lines([
    "import { computed, defineAsyncComponent, ref, watch } from 'vue';",
  ]),
  'import lazy mount state helpers',
);

replaceOnce(
  appSidebarFile,
  lines([
    "const isExplorerView = computed(() => props.view === 'explorer');",
    "const isSearchView = computed(() => props.view === 'search');",
    "const isSourceControlView = computed(() => props.view === 'source-control');",
    "const isRunView = computed(() => props.view === 'run');",
    "const isSshView = computed(() => props.view === 'extensions');",
    "const panelMeta = computed(() => SIDEBAR_META[props.view] ?? SIDEBAR_META.ai);",
  ]),
  lines([
    "const isExplorerView = computed(() => props.view === 'explorer');",
    "const isSearchView = computed(() => props.view === 'search');",
    "const isSourceControlView = computed(() => props.view === 'source-control');",
    "const isRunView = computed(() => props.view === 'run');",
    "const isSshView = computed(() => props.view === 'extensions');",
    "const panelMeta = computed(() => SIDEBAR_META[props.view] ?? SIDEBAR_META.ai);",
    '',
    '// Explorer is the default shell surface. Heavier panels are mounted lazily on first visit,',
    '// then kept alive with v-show so tab switching remains instant after the initial open.',
    'const hasMountedSourceControl = ref(false);',
    'const hasMountedSearch = ref(false);',
    'const hasMountedRun = ref(false);',
    'const hasMountedSsh = ref(false);',
    '',
    'watch(',
    '  () => props.view,',
    '  (view) => {',
    "    if (view === 'source-control') {",
    '      hasMountedSourceControl.value = true;',
    "    } else if (view === 'search') {",
    '      hasMountedSearch.value = true;',
    "    } else if (view === 'run') {",
    '      hasMountedRun.value = true;',
    "    } else if (view === 'extensions') {",
    '      hasMountedSsh.value = true;',
    '    }',
    '  },',
    '  { immediate: true },',
    ');',
  ]),
  'add lazy mounted sidebar panel state',
);

replaceOnce(
  appSidebarFile,
  '<SourceControlPanel v-show="isSourceControlView" class="h-full min-h-0 w-full flex-1" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :active-path="document.path" @open-file="handleOpenFile" @open-diff="handleOpenGitDiff" />',
  '<SourceControlPanel v-if="hasMountedSourceControl" v-show="isSourceControlView" class="h-full min-h-0 w-full flex-1" :is-active="isSourceControlView" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :active-path="document.path" @open-file="handleOpenFile" @open-diff="handleOpenGitDiff" />',
  'lazy mount source control panel',
);

replaceOnce(
  appSidebarFile,
  '<DeferredSearchSidebarPanel v-show="isSearchView" :document-path="document.path" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :preloaded-workspace-root="preloadedWorkspaceRoot" @open-file="handleOpenFile" />',
  '<DeferredSearchSidebarPanel v-if="hasMountedSearch" v-show="isSearchView" :is-active="isSearchView" :document-path="document.path" :is-desktop-runtime="isDesktopRuntime" :workspace-root-path="workspaceRootPath" :preloaded-workspace-root="preloadedWorkspaceRoot" @open-file="handleOpenFile" />',
  'lazy mount search panel',
);

replaceOnce(
  appSidebarFile,
  '<DeferredRunSidebarPanel v-show="isRunView" />',
  '<DeferredRunSidebarPanel v-if="hasMountedRun" v-show="isRunView" />',
  'lazy mount run panel',
);

replaceOnce(
  appSidebarFile,
  '<div v-show="isSshView" class="ssh-sidebar-host-shell flex min-h-0 w-full flex-1 flex-col overflow-hidden" >',
  '<div v-if="hasMountedSsh" v-show="isSshView" class="ssh-sidebar-host-shell flex min-h-0 w-full flex-1 flex-col overflow-hidden" >',
  'lazy mount ssh panel',
);

// 2) SourceControlPanel：即使面板已访问并被 keep-alive，隐藏时也不要响应 workspace
//    watcher 立即刷新 git status 或加载历史/分支/PR。重新切回 Git 面板时再补齐数据。
const sourceControlFile = 'src/components/workbench/sidebar/source-control/SourceControlPanel.vue';

replaceOnce(
  sourceControlFile,
  lines([
    'const props = defineProps<{',
    '  isDesktopRuntime: boolean;',
    '  workspaceRootPath: string | null;',
    '  activePath: string | null;',
    '}>();',
  ]),
  lines([
    'const props = withDefaults(',
    '  defineProps<{',
    '    isActive?: boolean;',
    '    isDesktopRuntime: boolean;',
    '    workspaceRootPath: string | null;',
    '    activePath: string | null;',
    '  }>(),',
    '  {',
    '    isActive: true,',
    '  },',
    ');',
  ]),
  'add active gate prop to source control panel',
);

replaceOnce(
  sourceControlFile,
  lines([
    'watch(',
    '  () => activeTab.value,',
    '  (nextTab) => {',
    "    if (!hasRepository.value || nextTab === 'changes') {",
    '      return;',
    '    }',
    '',
    '    void ensureActiveTabData(nextTab);',
    '  },',
    ');',
  ]),
  lines([
    'watch(',
    '  () => activeTab.value,',
    '  (nextTab) => {',
    "    if (!props.isActive || !hasRepository.value || nextTab === 'changes') {",
    '      return;',
    '    }',
    '',
    '    void ensureActiveTabData(nextTab);',
    '  },',
    ');',
  ]),
  'gate hidden source control tab data loads',
);

replaceOnce(
  sourceControlFile,
  lines([
    'watch(',
    '  [() => props.isDesktopRuntime, () => props.workspaceRootPath],',
    '  ([ready, workspaceRootPath]) => {',
    '    if (!ready || !workspaceRootPath) {',
    '      gitStore.reset();',
    '      sourceControlActionError.value = null;',
    '      return;',
    '    }',
    '    void syncRepositoryStatus(workspaceRootPath);',
    '  },',
    '  { immediate: true },',
    ');',
  ]),
  lines([
    'watch(',
    '  [() => props.isDesktopRuntime, () => props.workspaceRootPath, () => props.isActive],',
    '  ([ready, workspaceRootPath, active]) => {',
    '    if (!active) {',
    '      return;',
    '    }',
    '',
    '    if (!ready || !workspaceRootPath) {',
    '      gitStore.reset();',
    '      sourceControlActionError.value = null;',
    '      return;',
    '    }',
    '',
    '    void syncRepositoryStatus(workspaceRootPath);',
    '  },',
    '  { immediate: true },',
    ');',
  ]),
  'defer source control refresh until visible',
);

// 3) SearchSidebarPanel：访问后保持状态，但隐藏时不继续调度搜索/替换预览。
const searchFile = 'src/components/workbench/sidebar/search/SearchSidebarPanel.vue';

replaceOnce(
  searchFile,
  lines([
    'const props = defineProps<{',
    '  documentPath: string | null;',
    '  isDesktopRuntime: boolean;',
    '  workspaceRootPath: string | null;',
    '  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;',
    '}>();',
  ]),
  lines([
    'const props = withDefaults(',
    '  defineProps<{',
    '    isActive?: boolean;',
    '    documentPath: string | null;',
    '    isDesktopRuntime: boolean;',
    '    workspaceRootPath: string | null;',
    '    preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null;',
    '  }>(),',
    '  {',
    '    isActive: true,',
    '  },',
    ');',
  ]),
  'add active gate prop to search panel',
);

replaceOnce(
  searchFile,
  lines([
    'watch(',
    '  [',
    '    () => props.isDesktopRuntime,',
    '    () => props.workspaceRootPath,',
    '    searchQuery,',
    '    matchCase,',
    '    wholeWord,',
    '    useRegex,',
    '    contentFuzzy,',
    '    useStructural,',
    "    () => effectiveIncludePatterns.value.join('\\n'),",
    "    () => effectiveExcludePatterns.value.join('\\n'),",
    '  ],',
    '  scheduleSearch,',
    '  { immediate: true },',
    ');',
  ]),
  lines([
    'watch(',
    '  [',
    '    () => props.isActive,',
    '    () => props.isDesktopRuntime,',
    '    () => props.workspaceRootPath,',
    '    searchQuery,',
    '    matchCase,',
    '    wholeWord,',
    '    useRegex,',
    '    contentFuzzy,',
    '    useStructural,',
    "    () => effectiveIncludePatterns.value.join('\\n'),",
    "    () => effectiveExcludePatterns.value.join('\\n'),",
    '  ],',
    '  () => {',
    '    if (!props.isActive) {',
    '      cancelPendingSearch();',
    '      return;',
    '    }',
    '',
    '    scheduleSearch();',
    '  },',
    '  { immediate: true },',
    ');',
  ]),
  'gate hidden search scheduling',
);

replaceOnce(
  searchFile,
  lines([
    'watch(',
    '  [',
    '    searchQuery,',
    '    replacementQuery,',
    '    matchCase,',
    '    wholeWord,',
    '    useRegex,',
    '    useStructural,',
    "    () => effectiveIncludePatterns.value.join('\\n'),",
    "    () => effectiveExcludePatterns.value.join('\\n'),",
    '    () => props.workspaceRootPath,',
    '  ],',
    '  () => {',
    '    if (replacementApplying.value) return;',
  ]),
  lines([
    'watch(',
    '  [',
    '    () => props.isActive,',
    '    searchQuery,',
    '    replacementQuery,',
    '    matchCase,',
    '    wholeWord,',
    '    useRegex,',
    '    useStructural,',
    "    () => effectiveIncludePatterns.value.join('\\n'),",
    "    () => effectiveExcludePatterns.value.join('\\n'),",
    '    () => props.workspaceRootPath,',
    '  ],',
    '  () => {',
    '    if (!props.isActive) {',
    '      cancelPendingReplacement();',
    '      return;',
    '    }',
    '',
    '    if (replacementApplying.value) return;',
  ]),
  'gate hidden replacement preview scheduling',
);

console.log('\nThird performance patch script completed. No backup files were created.');