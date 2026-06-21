// scripts/codemods/floating-search-panel.mjs
// 把 CodeMirror 内置搜索面板换成「现代浅色 + 图标 + 可拖拽 + 跟随右键位置」的浮动小弹窗(仅查找)。
// 用法:在仓库根目录执行  node scripts/codemods/floating-search-panel.mjs
// 可选:node scripts/codemods/floating-search-panel.mjs <仓库根目录>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.argv[2] ?? '.';
const file = resolve(root, 'src/components/editor/CodeMirrorScriptEditor.vue');

let src = readFileSync(file, 'utf8');

if (src.includes('cm-floating-search') || src.includes('createSearchPanel')) {
  console.log('⏭  已包含浮动查找弹窗,跳过(幂等)。');
  process.exit(0);
}

const replaceOnce = (haystack, find, replacement, label) => {
  const first = haystack.indexOf(find);
  if (first === -1) throw new Error(`锚点未找到:${label}`);
  if (haystack.indexOf(find, first + find.length) !== -1)
    throw new Error(`锚点不唯一:${label}`);
  return haystack.slice(0, first) + replacement + haystack.slice(first + find.length);
};

// 1) 扩充 @codemirror/search 导入
const SEARCH_IMPORT = `import {
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from '@codemirror/search';`;
const SEARCH_IMPORT_NEW = `import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  gotoLine,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  SearchQuery,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search';`;
src = replaceOnce(src, SEARCH_IMPORT, SEARCH_IMPORT_NEW, '@codemirror/search import');

// 2) @codemirror/view 增加 Panel 类型
const VIEW_IMPORT = `  keymap,
  rectangularSelection,
  type ViewUpdate,
} from '@codemirror/view';`;
const VIEW_IMPORT_NEW = `  keymap,
  type Panel,
  rectangularSelection,
  type ViewUpdate,
} from '@codemirror/view';`;
src = replaceOnce(src, VIEW_IMPORT, VIEW_IMPORT_NEW, '@codemirror/view import');

// 3) 记录右键触发点的变量
const PREV_SIZE = `let previousContainerSize = { width: 0, height: 0 };`;
src = replaceOnce(
  src,
  PREV_SIZE,
  `${PREV_SIZE}\n// 记录最近一次右键触发点(视口坐标),供浮动查找弹窗智能定位;消费后置空。\nlet lastSearchTriggerPoint: { x: number; y: number } | null = null;`,
  'previousContainerSize decl',
);

// 4) openContextMenu 里捕获触发点
const OPEN_MENU = `const openContextMenu = (event: MouseEvent): void => {
  if (!editorView) return;
  const nextPosition = clampMenuPosition(event.clientX, event.clientY);`;
const OPEN_MENU_NEW = `const openContextMenu = (event: MouseEvent): void => {
  if (!editorView) return;
  lastSearchTriggerPoint = { x: event.clientX, y: event.clientY };
  const nextPosition = clampMenuPosition(event.clientX, event.clientY);`;
src = replaceOnce(src, OPEN_MENU, OPEN_MENU_NEW, 'openContextMenu');

// 5) 在 createBaseExtensions 之前插入自定义面板工厂
const CBE = `const createBaseExtensions = (language: string): Extension[] => [`;
const INSERT_PANEL = `// ──────────────────────────────
// Floating search popup (custom search panel)
// 自定义浮动查找弹窗:替代 CM 内置 search 面板。恒浅色、图标化、可拖拽,
// 出现位置智能匹配右键触发点(无触发点时回退到光标 / 编辑器顶部)。
// ──────────────────────────────
const SEARCH_POPUP_MARGIN = 12;
const SEARCH_POPUP_WIDTH = 320;
const SEARCH_POPUP_ESTIMATED_HEIGHT = 48;

const SEARCH_ICON_FIND =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
const SEARCH_ICON_PREV =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
const SEARCH_ICON_NEXT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const SEARCH_ICON_CLOSE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

const countSearchMatches = (
  view: EditorView,
  query: SearchQuery,
): { total: number; current: number } => {
  if (!query.valid) return { total: 0, current: 0 };
  const main = view.state.selection.main;
  let total = 0;
  let current = 0;
  const cursor = query.getCursor(view.state);
  while (!cursor.next().done) {
    total += 1;
    if (cursor.value.from === main.from && cursor.value.to === main.to) current = total;
  }
  return { total, current };
};

const createSearchPanel = (view: EditorView): Panel => {
  const dom = document.createElement('div');
  dom.className = 'cm-floating-search';
  dom.setAttribute('role', 'search');

  const grip = document.createElement('span');
  grip.className = 'cm-floating-search__grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.innerHTML = SEARCH_ICON_FIND;

  const input = document.createElement('input');
  input.className = 'cm-floating-search__input';
  input.type = 'text';
  input.placeholder = '查找';
  input.setAttribute('aria-label', '查找');
  input.spellcheck = false;

  const count = document.createElement('span');
  count.className = 'cm-floating-search__count';

  const createIconButton = (label: string, icon: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-floating-search__btn';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    return button;
  };

  const prevButton = createIconButton('上一个', SEARCH_ICON_PREV);
  const nextButton = createIconButton('下一个', SEARCH_ICON_NEXT);
  const closeButton = createIconButton('关闭', SEARCH_ICON_CLOSE);
  closeButton.classList.add('cm-floating-search__btn--close');

  dom.append(grip, input, count, prevButton, nextButton, closeButton);

  const refreshCount = (): void => {
    const query = getSearchQuery(view.state);
    if (!query.search) {
      count.textContent = '';
      return;
    }
    const { total, current } = countSearchMatches(view, query);
    count.textContent = total === 0 ? '无结果' : \`\${current || '–'}/\${total}\`;
  };

  const runQuery = (value: string): void => {
    const previous = getSearchQuery(view.state);
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: value,
          caseSensitive: previous.caseSensitive,
          regexp: previous.regexp,
          wholeWord: previous.wholeWord,
          literal: previous.literal,
        }),
      ),
    });
    refreshCount();
  };

  input.addEventListener('input', () => runQuery(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) findPrevious(view);
      else findNext(view);
      refreshCount();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPanel(view);
    }
  });
  prevButton.addEventListener('click', () => {
    findPrevious(view);
    refreshCount();
    input.focus();
  });
  nextButton.addEventListener('click', () => {
    findNext(view);
    refreshCount();
    input.focus();
  });
  closeButton.addEventListener('click', () => closeSearchPanel(view));

  // 把视口坐标换算到弹窗定位坐标系,兼容存在 transform 的祖先容器。
  const positionAt = (clientX: number, clientY: number): void => {
    const width = dom.offsetWidth || SEARCH_POPUP_WIDTH;
    const height = dom.offsetHeight || SEARCH_POPUP_ESTIMATED_HEIGHT;
    const x = Math.min(
      Math.max(SEARCH_POPUP_MARGIN, clientX),
      window.innerWidth - width - SEARCH_POPUP_MARGIN,
    );
    const y = Math.min(
      Math.max(SEARCH_POPUP_MARGIN, clientY),
      window.innerHeight - height - SEARCH_POPUP_MARGIN,
    );
    dom.style.left = \`\${x}px\`;
    dom.style.top = \`\${y}px\`;
    const rect = dom.getBoundingClientRect();
    dom.style.left = \`\${x + (x - rect.left)}px\`;
    dom.style.top = \`\${y + (y - rect.top)}px\`;
  };

  let dragPointerId: number | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  const onDragMove = (event: PointerEvent): void => {
    if (dragPointerId === null) return;
    positionAt(event.clientX - dragOffsetX, event.clientY - dragOffsetY);
  };
  const onDragEnd = (): void => {
    if (dragPointerId === null) return;
    dragPointerId = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
  };
  grip.addEventListener('pointerdown', (event) => {
    dragPointerId = event.pointerId;
    const rect = dom.getBoundingClientRect();
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    event.preventDefault();
  });

  return {
    dom,
    top: true,
    mount() {
      const query = getSearchQuery(view.state);
      if (query.search) input.value = query.search;
      const trigger = lastSearchTriggerPoint;
      lastSearchTriggerPoint = null;
      if (trigger) {
        positionAt(trigger.x, trigger.y);
      } else {
        const caret = view.coordsAtPos(view.state.selection.main.head);
        if (caret) {
          positionAt(caret.left, caret.bottom + 8);
        } else {
          const editorRect = view.dom.getBoundingClientRect();
          positionAt(editorRect.left + 24, editorRect.top + 16);
        }
      }
      refreshCount();
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    },
    update(update: ViewUpdate) {
      const queryChanged = update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(setSearchQuery)),
      );
      if (!update.docChanged && !update.selectionSet && !queryChanged) return;
      if (document.activeElement !== input) {
        const query = getSearchQuery(view.state);
        if (query.search !== input.value) input.value = query.search;
      }
      refreshCount();
    },
    destroy() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
    },
  };
};

`;
src = replaceOnce(src, CBE, INSERT_PANEL + CBE, 'createBaseExtensions');

// 6) 接上 createPanel
src = replaceOnce(
  src,
  `  search({ top: true }),`,
  `  search({ top: true, createPanel: createSearchPanel }),`,
  'search() call',
);

// 7) 注入全局样式(插到最后一个 </style> 之前)
const INSERT_CSS = `
/* 浮动查找弹窗:恒为浅色,沿用补全/hover 卡片同一套表面/描边/阴影语言 */
.cm-panels.cm-panels-top:has(.cm-floating-search) {
  border-bottom: none;
  background: transparent;
}

.cm-floating-search {
  position: fixed;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 4px;
  width: 320px;
  max-width: calc(100vw - 24px);
  padding: 5px 6px 5px 10px;
  background: #ffffff;
  border: 1px solid #e6e8eb;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 0 0 0.5px rgba(15, 23, 42, 0.04);
  font-family: var(--font-mono);
  color: #1f2937;
}

.cm-floating-search__grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  color: #98a2b3;
  cursor: grab;
  touch-action: none;
}

.cm-floating-search__grip:active {
  cursor: grabbing;
}

.cm-floating-search__grip svg {
  width: 15px;
  height: 15px;
}

.cm-floating-search__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 6px;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  color: #111827;
}

.cm-floating-search__input::placeholder {
  color: #98a2b3;
}

.cm-floating-search__count {
  flex-shrink: 0;
  min-width: 34px;
  padding: 0 4px;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #98a2b3;
}

.cm-floating-search__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: #475467;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.cm-floating-search__btn:hover {
  background: #f1f5f9;
  color: #111827;
}

.cm-floating-search__btn:active {
  background: #e7ebf0;
}

.cm-floating-search__btn svg {
  width: 16px;
  height: 16px;
}

.cm-floating-search__btn--close {
  color: #98a2b3;
}

.cm-floating-search__btn--close:hover {
  background: #fde8e8;
  color: #d92d20;
}
`;
const lastStyle = src.lastIndexOf('</style>');
if (lastStyle === -1) throw new Error('锚点未找到:</style>');
src = src.slice(0, lastStyle) + INSERT_CSS + '\n' + src.slice(lastStyle);

writeFileSync(file, src, 'utf8');
console.log('✓ 已改写 CodeMirrorScriptEditor.vue(浮动查找弹窗)');