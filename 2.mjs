// 一次性脚本：修复编辑器滚动卡顿（🔴1 空事务 / 🔴2 首行切片 / 🟠3 每帧响应式）。
// 用唯一锚点替换，找不到或命中多处即报错退出，绝不误改。跑完即可删除本文件。
import { readFileSync, writeFileSync } from 'node:fs';

const edits = [
  // ── 🔴2：新增「从首行切片」降级阈值常量 ──
  {
    file: 'src/services/editor/codemirror-shiki-highlight.ts',
    find: `const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;`,
    replace: `const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;

// 「从文档首行起」切片的舒适体积上限：超过即降级为有界窗口切片（仅取视口附近），避免向大
// 文件深处滚动时在主线程 sliceString 出超大前缀并结构化克隆给 Worker。低于
// MAX_HIGHLIGHT_SLICE_LENGTH（后者仍作为窗口切片的最终放弃阈值）。代价：极少数跨越数千行
// 的多行结构（超长 heredoc/字符串/注释）降级后可能着色不准，shell 脚本下罕见。
const MAX_FROM_DOCUMENT_START_SLICE_LENGTH = 120_000;`,
  },

  // ── 🔴2：降级判定改用新阈值 ──
  {
    file: 'src/services/editor/codemirror-shiki-highlight.ts',
    find: `  if (options.fromDocumentStart && sliceTo - sliceFrom > MAX_HIGHLIGHT_SLICE_LENGTH) {
    ({ range, sliceFrom, sliceTo } = buildSlice(false));
  }`,
    replace: `  if (options.fromDocumentStart && sliceTo - sliceFrom > MAX_FROM_DOCUMENT_START_SLICE_LENGTH) {
    ({ range, sliceFrom, sliceTo } = buildSlice(false));
  }`,
  },

  // ── 🔴1：纯滚动仅在视口存在未缓存行时才派发重算 ──
  {
    file: 'src/services/editor/codemirror-shiki-highlight.ts',
    find: `        if (update.viewportChanged && !languageChanged && !recomputeRequested) {
          // 纯滚动：先用按行缓存同步重建装饰（命中缓存的行零闪烁、不清空），再让 CodeMirror
          // 虚拟滚动把新行文本画出来，下一帧（post-paint）对新进入视口的未缓存行补算高亮。
          this.renderViewportFromCache(update.view);
          this.schedulePostPaintRecompute(update.view);
          return;
        }`,
    replace: `        if (update.viewportChanged && !languageChanged && !recomputeRequested) {
          // 纯滚动：先用按行缓存同步重建装饰（命中缓存的行零闪烁、不清空），再让 CodeMirror
          // 虚拟滚动把新行文本画出来，下一帧（post-paint）对新进入视口的未缓存行补算高亮。
          this.renderViewportFromCache(update.view);
          // 仅当新视口确有未缓存行时才安排重算派发。滚回已着色区域（或小文件整篇已缓存）时，
          // 跳过这次 dispatch——否则每次滚动停下都会多派发一个空事务，触发全量 update 循环
          // （所有 ViewPlugin.update 与 updateListener 重跑），与浏览器滚动/绘制抢主线程。
          if (!this.viewportFullyCached(update.view)) {
            this.schedulePostPaintRecompute(update.view);
          }
          return;
        }`,
  },

  // ── 🔴1：新增 viewportFullyCached 方法（紧跟 getVisibleLineRange 之后）──
  {
    file: 'src/services/editor/codemirror-shiki-highlight.ts',
    find: `    private getVisibleLineRange(view: EditorView): { first: number; last: number } | null {
      const { visibleRanges } = view;
      if (visibleRanges.length === 0) {
        return null;
      }
      const { doc } = view.state;
      return {
        first: doc.lineAt(visibleRanges[0].from).number,
        last: doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number,
      };
    }`,
    replace: `    private getVisibleLineRange(view: EditorView): { first: number; last: number } | null {
      const { visibleRanges } = view;
      if (visibleRanges.length === 0) {
        return null;
      }
      const { doc } = view.state;
      return {
        first: doc.lineAt(visibleRanges[0].from).number,
        last: doc.lineAt(visibleRanges[visibleRanges.length - 1].to).number,
      };
    }

    /**
     * 当前视口（含 overscan）是否已全部命中按行缓存。用于纯滚动时判定能否跳过重算派发：
     * 返回 true 表示这次滚动可见区无需 tokenize，recompute 也只会同步重建装饰（空操作），
     * 故可安全跳过派发。缓存上下文（语言/文档版本）与当前不一致时一律返回 false，把作废与
     * 重算交给 recompute，避免用过期缓存误判而漏掉重算。判定范围与 recompute 内完全一致。
     */
    private viewportFullyCached(view: EditorView): boolean {
      const language = view.state.field(shikiLanguageField, false) ?? 'text';
      if (this.cacheLanguage !== language || this.cacheDocVersion !== this.docVersion) {
        return false;
      }
      const visible = this.getVisibleLineRange(view);
      if (!visible) {
        return false;
      }
      const range = computeShikiHighlightRange({
        firstVisibleLine: visible.first,
        lastVisibleLine: visible.last,
        totalLines: view.state.doc.lines,
        overscanLines: HIGHLIGHT_OVERSCAN_LINES,
        leadInLines: HIGHLIGHT_OVERSCAN_LINES,
        fromDocumentStart: false,
      });
      return (
        findUncachedLineRange({
          startLine: range.startLine,
          endLine: range.endLine,
          isCached: (lineNumber) => this.lineTokenCache.has(lineNumber),
        }) === null
      );
    }`,
  },

  // ── 🟠3：closeContextMenu 幂等化 ──
  {
    file: 'src/components/editor/CodeMirrorScriptEditor.vue',
    find: `const closeContextMenu = (): void => {
  contextMenuState.value.open = false;
  contextMenuGroups.value = [];
};`,
    replace: `const closeContextMenu = (): void => {
  // 幂等保护：菜单本就关闭且分组已空时直接返回，避免每帧滚动都给 contextMenuGroups 赋新空
  // 数组（handleEditorUpdate 的 viewportChanged 分支每帧调用本函数），触发无意义 Vue 响应式更新。
  if (!contextMenuState.value.open && contextMenuGroups.value.length === 0) return;
  contextMenuState.value.open = false;
  contextMenuGroups.value = [];
};`,
  },
];

let ok = true;
const byFile = new Map();
for (const e of edits) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)).push(e);

for (const [file, fileEdits] of byFile) {
  let content = readFileSync(file, 'utf8');
  for (const e of fileEdits) {
    const count = content.split(e.find).length - 1;
    if (count !== 1) {
      console.error(`✗ ${file}: 锚点命中 ${count} 处（期望 1），跳过。请检查文件是否已改动。`);
      console.error(`  锚点首行: ${e.find.split('\n')[0]}`);
      ok = false;
      continue;
    }
    content = content.replace(e.find, e.replace);
    console.log(`✓ ${file}: ${e.find.split('\n')[0].slice(0, 60)}…`);
  }
  if (ok) writeFileSync(file, content, 'utf8');
}

if (!ok) {
  console.error('\n有锚点未精确命中，未写入任何文件。');
  process.exit(1);
}
console.log('\n全部完成。请执行 git diff 复核，本地构建验证后提交。');