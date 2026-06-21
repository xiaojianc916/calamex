#!/usr/bin/env node
// optimize-calamex-r2.mjs
// 第二批严格代码审查优化（findings F6–F9）。
// 安全设计：纯文本锚点替换；幂等（可重复运行不会重复插入）；
//           --dry-run 预演不写盘；--revert 一键回滚；锚点缺失/歧义即非零退出。
// 用法（在仓库根目录执行）：
//   node optimize-calamex-r2.mjs              应用全部优化
//   node optimize-calamex-r2.mjs --dry-run    仅预演
//   node optimize-calamex-r2.mjs --revert     回滚
//   node optimize-calamex-r2.mjs --revert --dry-run

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const REVERT = process.argv.includes('--revert');
const b = (...lines) => lines.join('\n'); // 多行锚点拼接（双引号字符串，内部单引号/反引号均为字面量，零转义）

// ──────────────────────────────────────────────────────────────────────────
// 优化目标：每条 edit 都是「唯一锚点」精确替换
// ──────────────────────────────────────────────────────────────────────────
const TARGETS = [
  // ===== F6：useDocumentPersistence.ts =====
  {
    file: 'src/composables/useDocumentPersistence.ts',
    edits: [
      {
        label: 'F6 引入 NonFormattableTargetError 专用错误类型',
        from: "const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';",
        to: b(
          "const NON_FORMATTABLE_TARGET_MESSAGE = '当前目标不是可格式化的文本文件。';",
          "",
          "// 用专门的错误类型表达「目标不可格式化」，取代散落的字符串字面量比较（stringly-typed control flow）。",
          "class NonFormattableTargetError extends Error {",
          "  constructor() {",
          "    super(NON_FORMATTABLE_TARGET_MESSAGE);",
          "    this.name = 'NonFormattableTargetError';",
          "  }",
          "}",
          "",
          "const isTextDocument = (document: IEditorDocument): boolean => document.kind === 'text';",
        ),
      },
      {
        label: 'F6 抛出改用专用错误类型',
        from: b(
          "      if (!isTextDocument(existingDocument)) {",
          "        throw new Error('当前目标不是可格式化的文本文件。');",
          "      }",
        ),
        to: b(
          "      if (!isTextDocument(existingDocument)) {",
          "        throw new NonFormattableTargetError();",
          "      }",
        ),
      },
      {
        label: 'F6 捕获改用 instanceof 判定',
        from: b(
          "      if (error instanceof Error && error.message === '当前目标不是可格式化的文本文件。') {",
          "        return warnAndReturnFalse(error.message);",
          "      }",
        ),
        to: b(
          "      if (error instanceof NonFormattableTargetError) {",
          "        return warnAndReturnFalse(error.message);",
          "      }",
        ),
      },
    ],
  },

  // ===== F7 + F9：useShellWorkbenchView.ts =====
  {
    file: 'src/composables/useShellWorkbenchView.ts',
    edits: [
      {
        label: 'F7 删除未使用的 DEFAULT_TERMINAL_PANEL_HEIGHT import',
        from: b(
          "import { useWorkbench } from '@/composables/useWorkbench';",
          "import { DEFAULT_TERMINAL_PANEL_HEIGHT } from '@/store/app';",
          "import { useGitStore } from '@/store/git';",
        ),
        to: b(
          "import { useWorkbench } from '@/composables/useWorkbench';",
          "import { useGitStore } from '@/store/git';",
        ),
      },
      {
        label: 'F9 openDiagnosticsPanel 去除冗余 async',
        from: "  const openDiagnosticsPanel = async (): Promise<void> => {",
        to: "  const openDiagnosticsPanel = (): void => {",
      },
      {
        label: 'F9 toggleDiagnosticsPanel 移除多余 await',
        from: "    await openDiagnosticsPanel();",
        to: "    openDiagnosticsPanel();",
      },
      {
        label: 'F9 openTerminal 去除冗余 async',
        from: "  const openTerminal = async (): Promise<void> => {",
        to: "  const openTerminal = (): void => {",
      },
      {
        label: 'F9 handleSelectSidebarView 去除冗余 async',
        from: "  const handleSelectSidebarView = async (view: TWorkbenchSidebarView): Promise<void> => {",
        to: "  const handleSelectSidebarView = (view: TWorkbenchSidebarView): void => {",
      },
    ],
  },

  // ===== F8：useWorkbenchDocumentIO.ts =====
  {
    file: 'src/composables/useWorkbenchDocumentIO.ts',
    edits: [
      {
        label: 'F8 简化 restoreOpenTabs 为纯同步映射',
        from: b(
          "  const restoreOpenTabs = async (",
          "    openTabs: TRestorableSessionSnapshot['openTabs'],",
          "  ): Promise<TRestoredSessionTab[]> => {",
          "    const restoredTabs = openTabs",
          "      .map((tab): TRestoredSessionTab | null => {",
          "        const kind = resolveSessionTabKind(tab);",
          "        return {",
          "          kind,",
          "          path: tab.path,",
          "          name: getPathBaseName(tab.path),",
          "          order: tab.order,",
          "        };",
          "      })",
          "      .filter(isRestoredSessionTab)",
          "      .sort((left, right) => left.order - right.order);",
          "",
          "    return restoredTabs;",
          "  };",
        ),
        to: b(
          "  const restoreOpenTabs = (",
          "    openTabs: TRestorableSessionSnapshot['openTabs'],",
          "  ): TRestoredSessionTab[] =>",
          "    openTabs",
          "      .map((tab): TRestoredSessionTab => ({",
          "        kind: resolveSessionTabKind(tab),",
          "        path: tab.path,",
          "        name: getPathBaseName(tab.path),",
          "        order: tab.order,",
          "      }))",
          "      .sort((left, right) => left.order - right.order);",
        ),
      },
      {
        label: 'F8 调用处移除多余 await',
        from: "    const aliveTabs = await restoreOpenTabs(snapshot.openTabs);",
        to: "    const aliveTabs = restoreOpenTabs(snapshot.openTabs);",
      },
      {
        label: 'F8 删除随之无用的 isRestoredSessionTab 类型守卫',
        from: b(
          "const buildLogDetail = (title: string, detail: string): string => `${title}：${detail}`;",
          "",
          "const isRestoredSessionTab = (value: TRestoredSessionTab | null): value is TRestoredSessionTab =>",
          "  value !== null;",
          "",
          "const isSameGitDiffPreview = (",
        ),
        to: b(
          "const buildLogDetail = (title: string, detail: string): string => `${title}：${detail}`;",
          "",
          "const isSameGitDiffPreview = (",
        ),
      },
    ],
  },

  // ===== F9：useBrowserContextMenu.ts =====
  {
    file: 'src/composables/useBrowserContextMenu.ts',
    edits: [
      {
        label: 'F9 select-all 分支补上漏写的 await（消除 floating promise）',
        from: b(
          "      case 'select-all':",
          "        handleSelectAll(target);",
          "        return;",
        ),
        to: b(
          "      case 'select-all':",
          "        await handleSelectAll(target);",
          "        return;",
        ),
      },
    ],
  },

  // ===== F9：ShellWorkbenchView.vue（openTerminal 的唯一消费点）=====
  {
    file: 'src/views/ShellWorkbenchView.vue',
    edits: [
      {
        label: 'F9 handleOpenTerminal 跟随 openTerminal 改为同步',
        from: b(
          "const handleOpenTerminal = async (): Promise<void> => {",
          "  isEditorCollapsed.value = false;",
          "  await openTerminal();",
          "};",
        ),
        to: b(
          "const handleOpenTerminal = (): void => {",
          "  isEditorCollapsed.value = false;",
          "  openTerminal();",
          "};",
        ),
      },
    ],
  },
];

// ──────────────────────────────────────────────────────────────────────────
// 幂等替换引擎
//   - 普通/增长型编辑（to ⊅⊂ from 或 from⊂to）：以「目标串已存在」判定已应用
//   - 收缩型编辑（to⊂from，含插入类编辑的回滚）：以「源串已消失」判定已应用
//   这样无论正向/--revert 都可重复运行而不重复改动（修复了上一版 from⊂to 重复插入的隐患）
// ──────────────────────────────────────────────────────────────────────────
const tally = { applied: [], skipped: [], missing: [], ambiguous: [] };

function applyEdit(content, from, to, label) {
  const toInFrom = from.includes(to);
  const alreadyApplied = toInFrom ? !content.includes(from) : content.includes(to);
  if (alreadyApplied) {
    tally.skipped.push(label);
    return content;
  }
  const first = content.indexOf(from);
  if (first === -1) {
    tally.missing.push(label);
    return content;
  }
  if (content.indexOf(from, first + from.length) !== -1) {
    tally.ambiguous.push(label); // 锚点不唯一：拒绝替换，避免误伤
    return content;
  }
  tally.applied.push(label);
  return content.slice(0, first) + to + content.slice(first + from.length);
}

for (const target of TARGETS) {
  const abs = resolve(process.cwd(), target.file);
  if (!existsSync(abs)) {
    tally.missing.push(`${target.file}（文件不存在，请在仓库根目录运行）`);
    continue;
  }
  const original = readFileSync(abs, 'utf8');
  let content = original;
  for (const edit of target.edits) {
    const from = REVERT ? edit.to : edit.from;
    const to = REVERT ? edit.from : edit.to;
    content = applyEdit(content, from, to, `${target.file} :: ${edit.label}`);
  }
  if (content !== original && !DRY_RUN) {
    writeFileSync(abs, content, 'utf8');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 报告
// ──────────────────────────────────────────────────────────────────────────
const mode = `${REVERT ? '回滚' : '应用'}${DRY_RUN ? '（预演 dry-run，未写盘）' : ''}`;
console.log(`\n=== calamex 第二批优化 ${mode} ===`);
const line = (emoji, title, arr) => {
  if (arr.length === 0) return;
  console.log(`\n${emoji} ${title}（${arr.length}）`);
  for (const x of arr) console.log(`   - ${x}`);
};
line('✅', REVERT ? '已回滚' : '已应用', tally.applied);
line('⏭️', '已是目标状态，跳过', tally.skipped);
line('⚠️', '锚点缺失（可能版本已变）', tally.missing);
line('⛔', '锚点不唯一，已拒绝替换', tally.ambiguous);

const failed = tally.missing.length + tally.ambiguous.length;
console.log(
  `\n小计：应用 ${tally.applied.length}｜跳过 ${tally.skipped.length}｜缺失 ${tally.missing.length}｜歧义 ${tally.ambiguous.length}\n`,
);
process.exit(failed > 0 ? 1 : 0);