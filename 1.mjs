// collapse-resize-freeze-blocklist.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const cssPath = resolve(process.cwd(), 'src/styles/app-shell.css');
if (!existsSync(cssPath)) {
  console.error(`[路径错误] 找不到 ${cssPath}\n请在包含 src/ 的目录（my_desktop_app）下运行。`);
  process.exit(1);
}

const UNIVERSAL_RULE = `/* 窗口 resize 冻结：在 html.is-resizing 存续期间用一条通用规则关掉所有
 * transition/animation（该 class 由 useWindowResizeState 在每次 ResizeObserver
 * 回调时加上，resize 停稳 160ms 后移除）。取代此前手工维护的 ~50 选择器名单——
 * 新增组件自动被冻结，不再有“忘了往名单里加”的维护陷阱；开销仅限拖拽那一小段。 */
html.is-resizing *,
html.is-resizing *::before,
html.is-resizing *::after {
  transition: none !important;
  animation: none !important;
}

`;

const ops = [
  {
    // A) 插入通用规则 + rule1 去掉冗余 transition（保留 background 防漏底）
    find: `html.is-resizing .app-window-shell,
html.is-resizing .app-shell-pane,
html.is-resizing .workbench-content-card,
html.is-resizing .editor-surface {
  background: #fafafa !important;
  transition: none !important;
}
`,
    replace: `${UNIVERSAL_RULE}html.is-resizing .app-window-shell,
html.is-resizing .app-shell-pane,
html.is-resizing .workbench-content-card,
html.is-resizing .editor-surface {
  background: #fafafa !important;
}
`,
  },
  {
    // B) 删除 rule2（纯 animation/transition 冻结，已被通用规则覆盖）
    find: `html.is-resizing .app-shell-pane,
html.is-resizing .workbench-editor-viewport,
html.is-resizing .workbench-content-stage,
html.is-resizing .workbench-content-dock,
html.is-resizing .workbench-content-card,
html.is-resizing .editor-surface {
  animation: none !important;
  transition: none !important;
}

`,
    replace: '',
  },
  {
    // C) 删除 rule5（~40 选择器的纯冻结大名单，已被通用规则覆盖）
    find: `html.is-resizing .ai-workspace-right-sidebar,
html.is-resizing .ai-icon-button,
html.is-resizing .ai-suggestion-empty :is(button),
html.is-resizing .ai-chat-scroll-button,
html.is-resizing .ai-message,
html.is-resizing .ai-message-bubble,
html.is-resizing .ai-message-option-button,
html.is-resizing .ai-message-copy-button,
html.is-resizing .ai-tool-call,
html.is-resizing .ai-runtime-timeline,
html.is-resizing .ai-runtime-chain-header,
html.is-resizing .ai-runtime-terminal-toggle,
html.is-resizing .ai-runtime-terminal,
html.is-resizing .ai-markdown,
html.is-resizing .markstream-vue,
html.is-resizing .markdown-renderer,
html.is-resizing .cm-editor,
html.is-resizing .cm-scroller,
html.is-resizing .cm-gutters,
html.is-resizing .cm-tooltip,
html.is-resizing .cm-mergeView,
html.is-resizing .codemirror-editor-surface,
html.is-resizing .shell-editor-surface,
html.is-resizing .image-asset-preview,
html.is-resizing .image-asset-preview-scroll,
html.is-resizing .image-preview-stage,
html.is-resizing .image-preview-frame,
html.is-resizing .image-preview-asset,
html.is-resizing .ai-panel-frame,
html.is-resizing .ai-panel-frame__body,
html.is-resizing .ai-panel-frame__composer,
html.is-resizing .embedded-terminal-shell,
html.is-resizing .embedded-terminal-host,
html.is-resizing .xterm,
html.is-resizing .xterm-viewport,
html.is-resizing .git-diff-viewer,
html.is-resizing .git-diff-viewer-surface {
  animation: none !important;
  transition: none !important;
}

`,
    replace: '',
  },
];

let css = readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
for (const { find } of ops) {
  const count = css.split(find).length - 1;
  if (count !== 1) {
    console.error(`[校验失败] 锚点出现 ${count} 次（应为 1）:\n---\n${find.slice(0, 160)}…\n---`);
    process.exit(1);
  }
}
for (const { find, replace } of ops) css = css.replace(find, replace);
writeFileSync(cssPath, css, 'utf8');
console.log('[完成] app-shell.css 冻结名单已收敛为一条通用规则。');