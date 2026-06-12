#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src/components/workbench/SourceControlPanel.vue';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

let source = readFileSync(absolutePath, 'utf8');

const replaceOnce = (oldText, newText, label) => {
  if (source.includes(newText)) {
    return;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }

  source = source.replace(oldText, newText);
};

const insertAfterOnce = (anchor, insertion, label) => {
  if (source.includes(insertion.trim())) {
    return;
  }

  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 anchor match, got ${count}`);
  }

  source = source.replace(anchor, `${anchor}${insertion}`);
};

// 1. 模板：给原有滚动容器绑定渐进加载，不新增滚动条。
replaceOnce(
  `      <div class="source-control-scroll">`,
  `      <div ref="sourceControlScrollRef" class="source-control-scroll" @scroll.passive="handleSourceControlScroll">`,
  'bind source-control scroll progressive loader',
);

replaceOnce(
  `          <section v-for="section in filteredSections" :key="section.key" class="source-control-section"`,
  `          <section v-for="section in visibleFilteredSections" :key="section.key" class="source-control-section"`,
  'render visible filtered sections',
);

replaceOnce(
  `              <article v-for="entry in section.entries" :key="section.key + ':' + entry.path"`,
  `              <article v-for="entry in section.visibleEntries" :key="section.key + ':' + entry.path"`,
  'render visible source-control entries',
);

// 2. 常量：每页 120 条，底部 96px 预加载。
insertAfterOnce(
  `const SOURCE_CONTROL_MENU_ROOT_SELECTOR = '.linear-context-menu-root';
`,
  `const SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE = 120;
const SOURCE_CONTROL_LOAD_MORE_THRESHOLD_PX = 96;
`,
  'add progressive render constants',
);

// 3. 类型：保留完整 entries 计数，同时提供 visibleEntries 渲染。
insertAfterOnce(
  `interface IGitSection {
  key: TGitSectionKey;
  title: string;
  entries: IGitFileStatusPayload[];
}

`,
  `interface IVisibleGitSection extends IGitSection {
  visibleEntries: IGitFileStatusPayload[];
  hasMore: boolean;
}

`,
  'add visible git section interface',
);

// 4. 状态：记录每个 section 当前可见上限。
insertAfterOnce(
  `const activeTab = ref<TGitNavKey>('changes');
`,
  `const sourceControlScrollRef = ref<HTMLElement | null>(null);
`,
  'add source-control scroll ref',
);

insertAfterOnce(
  `const collapsedSections = reactive<Record<TGitSectionKey, boolean>>({
  conflicts: false,
  staged: false,
  changes: false,
  untracked: false,
});
`,
  `const visibleEntryLimits = reactive<Record<TGitSectionKey, number>>({
  conflicts: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
  staged: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
  changes: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
  untracked: SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
});

const resetVisibleEntryLimits = (): void => {
  visibleEntryLimits.conflicts = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
  visibleEntryLimits.staged = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
  visibleEntryLimits.changes = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
  visibleEntryLimits.untracked = SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
};
`,
  'add visible entry limit state',
);

// 5. 计算：在完整 filteredSections 基础上裁剪可见列表，功能仍使用完整数据。
const filteredSectionsPattern =
  /const filteredSections = computed<IGitSection\[\]>\(\(\) => \{[\s\S]*?\n\}\);\n\nconst hasVisibleChanges = computed/;

if (!source.includes('const visibleFilteredSections = computed<IVisibleGitSection[]>')) {
  const match = source.match(filteredSectionsPattern);
  if (!match) {
    fail('找不到 filteredSections computed 块');
  }

  source = source.replace(
    match[0],
    `${match[0].replace('\n\nconst hasVisibleChanges = computed', '')}

const visibleFilteredSections = computed<IVisibleGitSection[]>(() =>
  filteredSections.value.map((section) => {
    const limit = visibleEntryLimits[section.key] ?? SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
    const visibleEntries = section.entries.slice(0, limit);
    return {
      ...section,
      visibleEntries,
      hasMore: visibleEntries.length < section.entries.length,
    };
  }),
);

const hasHiddenSourceControlEntries = computed(() =>
  visibleFilteredSections.value.some((section) => section.hasMore),
);

const loadMoreVisibleSourceControlEntries = (): void => {
  if (!hasHiddenSourceControlEntries.value) {
    return;
  }

  for (const section of filteredSections.value) {
    const currentLimit = visibleEntryLimits[section.key] ?? SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE;
    if (currentLimit >= section.entries.length) {
      continue;
    }

    visibleEntryLimits[section.key] = Math.min(
      currentLimit + SOURCE_CONTROL_VISIBLE_ENTRY_PAGE_SIZE,
      section.entries.length,
    );
  }
};

const handleSourceControlScroll = (event: Event): void => {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
  if (distanceFromBottom <= SOURCE_CONTROL_LOAD_MORE_THRESHOLD_PX) {
    loadMoreVisibleSourceControlEntries();
  }
};

const hasVisibleChanges = computed`,
  );
}

// 6. workspace 切换时也重置渲染分页。
replaceOnce(
  `    closeSourceControlMenu();
    resetSectionCollapse();`,
  `    closeSourceControlMenu();
    resetSectionCollapse();
    resetVisibleEntryLimits();`,
  'reset visible entries on workspace change',
);

// 7. 搜索或 Git 状态列表数量变化时，回到第一页，避免旧 limit 泄漏到新筛选结果。
insertAfterOnce(
  `watch(
  () => props.workspaceRootPath,
  () => {
    commitMessage.value = '';
    searchQuery.value = '';
    activeTab.value = 'changes';
    sourceControlActionError.value = null;
    closeSourceControlMenu();
    resetSectionCollapse();
    resetVisibleEntryLimits();
  },
);

`,
  `watch(
  [() => searchQuery.value, () => status.value.files.length],
  () => {
    resetVisibleEntryLimits();
  },
);

`,
  'add visible entries reset watcher',
);

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round9 SCM progressive render optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Avoids mounting every Git changed-file row at once in large repositories.');
console.log(' - Keeps bulk actions and Git operations using the complete underlying data.');
console.log(' - Reuses the existing source-control scroll container; no new scrollbar.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test src/components/workbench/SourceControlPanel.spec.ts');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);