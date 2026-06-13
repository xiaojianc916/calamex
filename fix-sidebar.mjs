// fix-sidebar.mjs —— 在仓库根目录运行：node fix-sidebar.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const BASE = "src/components/workbench/sidebar/search";

// 每个文件一组 [查找, 替换] 编辑；找不到旧串但已是新串时视为「已处理」跳过
const EDITS = {
  [`${BASE}/ReplacementPreviewFile.vue`]: [
    [
      "import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';",
      "import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';",
    ],
  ],
  [`${BASE}/SearchResultGroup.vue`]: [
    [
      "import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';",
      "import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';",
    ],
  ],
  [`${BASE}/SearchResultsList.vue`]: [
    [
      "import ExplorerEntryIcon from '@/components/workbench/ExplorerEntryIcon.vue';",
      "import ExplorerEntryIcon from '@/components/workbench/sidebar/explorer/ExplorerEntryIcon.vue';",
    ],
  ],
  [`${BASE}/SearchSidebarPanel.vue`]: [
    [
      "const isDesktopRuntime = toRef(props, 'isDesktopRuntime');",
      "const isDesktopRuntimeRef = toRef(props, 'isDesktopRuntime');",
    ],
    [
      "const workspaceRootPath = toRef(props, 'workspaceRootPath');",
      "const workspaceRootPathRef = toRef(props, 'workspaceRootPath');",
    ],
    [
      "const search = useWorkspaceSearch({ isDesktopRuntime, workspaceRootPath, emitOpenFile });",
      "const search = useWorkspaceSearch({\n  isDesktopRuntime: isDesktopRuntimeRef,\n  workspaceRootPath: workspaceRootPathRef,\n  emitOpenFile,\n});",
    ],
    [
      "const replacement = useWorkspaceReplacement({\n  isDesktopRuntime,\n  workspaceRootPath,\n",
      "const replacement = useWorkspaceReplacement({\n  isDesktopRuntime: isDesktopRuntimeRef,\n  workspaceRootPath: workspaceRootPathRef,\n",
    ],
  ],
};

let hadError = false;

for (const [file, edits] of Object.entries(EDITS)) {
  if (!existsSync(file)) {
    console.error(`✗ 缺少文件：${file}`);
    hadError = true;
    continue;
  }
  let text = readFileSync(file, "utf8");
  const before = text;
  for (const [find, replace] of edits) {
    if (text.includes(find)) {
      text = text.split(find).join(replace);
    } else if (text.includes(replace)) {
      console.log(`• 已处理，跳过：${file} → ${find.slice(0, 40)}…`);
    } else {
      console.error(`✗ 未匹配：${file}\n    期望片段：${find.slice(0, 60)}…`);
      hadError = true;
    }
  }
  if (text !== before) {
    writeFileSync(file, text, "utf8");
    console.log(`✓ 已修改：${file}`);
  }
}

if (hadError) {
  console.error("\n有未匹配项，请把上面的输出贴给我，先别提交。");
  process.exit(1);
} else {
  console.log("\n全部完成。接着执行：git add -A && git commit --no-edit && git push origin main");
}