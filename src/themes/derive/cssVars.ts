/**
 * Deriver: CSS Variables
 *
 * 将 L2 Roles + L3 ComponentTokens 注入为 document.documentElement 上的
 * CSS 自定义属性，保持与现有 UI 代码中 var(--xxx) 引用名称完全兼容。
 *
 * 规则：
 *  - 此函数是纯副作用函数，不返回值
 *  - 仅在 document 可用时执行（防 SSR）
 *  - 变量名遵循现有约定（向后兼容）
 *  - 不注入非颜色令牌（--radius、字号等由用户设置覆盖）
 */
import type { IComponentTokens, IRoles } from '../tokens/types';

/**
 * 将组件令牌作为 CSS 变量注入 :root（即 `<html>` 元素的 style 属性）。
 */
export function emitCssVars(roles: IRoles, tokens: IComponentTokens): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  const set = (name: string, value: string): void => {
    root.style.setProperty(name, value);
  };

  // ── Linear / Woodsmoke 基础层级 ─────────────────────────────────────────
  set('--bg-0', roles.surface.app);
  set('--bg-1', roles.surface.sidebar);
  set('--bg-2', roles.surface.panelDepth);
  set('--bg-3', roles.surface.overlayDepth);
  set('--bg-4', roles.surface.overlay);
  set('--bg-h', roles.surface.hover);
  set('--bg-s', roles.surface.selection);
  set('--bg-a', roles.surface.softStrong);
  set('--bg-code', roles.surface.editor);
  set('--bg-gutter', roles.surface.editorGutter);

  // ── 布局区域 ──────────────────────────────────────────────────────────────
  set('--app-bg', tokens.layout.app.background);
  set('--titlebar-bg', tokens.layout.titlebar.background);
  set('--activity-bg', tokens.layout.activityRail.background);
  set('--sidebar-bg', tokens.layout.sidebar.background);
  set('--statusbar-bg', tokens.layout.statusbar.background);
  set('--statusbar-accent', tokens.layout.statusbar.accent);
  set('--tabbar-bg', tokens.layout.tabbar.background);

  // ── 编辑器 ────────────────────────────────────────────────────────────────
  set('--editor-bg', tokens.editor.background);
  set('--editor-gutter-bg', tokens.editor.gutter);
  set('--editor-surface', tokens.editor.surface);

  // ── Tab ────────────────────────────────────────────────────────────────────
  set('--tab-active-bg', tokens.tab.background.active);
  set('--tab-hover-bg', tokens.tab.background.hover);

  // ── 面板 ──────────────────────────────────────────────────────────────────
  set('--panel-bg', tokens.panel.background);
  set('--panel-muted', tokens.panel.backgroundDepth);

  // ── 交互遮罩 ──────────────────────────────────────────────────────────────
  set('--surface-hover', tokens.surface.hover);
  set('--surface-soft', tokens.surface.soft);
  set('--surface-soft-strong', tokens.surface.softStrong);

  // ── 边框 ──────────────────────────────────────────────────────────────────
  set('--border-subtle', tokens.border.subtle);
  set('--border-strong', tokens.border.strong);
  set('--shell-divider', tokens.border.divider);

  // ── 文字 ──────────────────────────────────────────────────────────────────
  set('--text-primary', tokens.text.primary);
  set('--text-secondary', tokens.text.secondary);
  set('--text-tertiary', tokens.text.tertiary);
  set('--text-quaternary', tokens.text.quaternary);

  // ── 品牌强调色 ────────────────────────────────────────────────────────────
  // 注意：--accent 同时供 Tailwind bg-accent 使用；
  // 此处写入品牌值，用户偏好由 store/app.ts 在之后覆盖
  set('--accent', tokens.accent.default);
  set('--accent-foreground', tokens.text.onAccent);
  set('--accent-strong', tokens.accent.strong);
  set('--accent-muted', tokens.accent.muted);
  set('--settings-accent', tokens.accent.default);
  set('--settings-accent-soft', tokens.accent.soft);
  set('--settings-accent-muted', tokens.accent.muted);

  // ── 状态色 ────────────────────────────────────────────────────────────────
  set('--success', tokens.status.success);
  set('--warning', tokens.status.warning);
  set('--danger', tokens.status.danger);

  // ── Diff ──────────────────────────────────────────────────────────────────
  set('--diff-modified', tokens.diff.modified);
  set('--diff-added', tokens.diff.added);
  set('--diff-deleted', tokens.diff.deleted);
  set('--diff-divider', tokens.diff.divider);

  // ── 浮层（菜单/下拉/Popover）────────────────────────────────────────────
  set('--overlay-bg', tokens.overlay.background);
  set('--overlay-bg-depth', tokens.overlay.backgroundDepth);
  set('--overlay-border', tokens.overlay.border);
  set('--overlay-separator', tokens.overlay.separator);

  // ── 语法高亮（供非编辑器场景引用）────────────────────────────────────
  set('--syntax-comment', tokens.syntax.comment);
  set('--syntax-keyword', tokens.syntax.keyword);
  set('--syntax-string', tokens.syntax.string);
  set('--syntax-number', tokens.syntax.number);
  set('--syntax-variable', tokens.syntax.variable);
  set('--syntax-type', tokens.syntax.type);
  set('--syntax-operator', tokens.syntax.operator);
  set('--syntax-cursor', tokens.syntax.cursor);

  // ── 规范化：供 Tailwind/Shadcn @theme inline 消费 ──────────────────────
  // (background/foreground/card/... 由 styles.css 的 :root 提供初值，
  //  此处同步与 L3 重叠的部分，避免 Shadcn 组件颜色漂移)
  set('--background', tokens.layout.app.background);
  set('--foreground', tokens.text.primary);
  set('--card', tokens.layout.sidebar.background);
  set('--card-foreground', tokens.text.primary);
  set('--popover', tokens.overlay.background);
  set('--popover-foreground', tokens.text.primary);
  set('--primary', tokens.accent.default);
  set('--primary-foreground', tokens.text.onAccent);
  set('--secondary', tokens.editor.surface);
  set('--secondary-foreground', tokens.text.primary);
  set('--muted', tokens.panel.backgroundDepth);
  set('--muted-foreground', tokens.text.tertiary);
  set('--input', tokens.border.divider);
  set('--border', tokens.border.subtle);
  set('--ring', tokens.accent.default);

  // ── 调试用角色变量（可选，供自定义面板消费，生产代码不应依赖）──────────
  // 前缀 --r- 标识"仅调试/自定义"
  set('--r-surface-app', roles.surface.app);
  set('--r-surface-editor', roles.surface.editor);
  set('--r-surface-editor-gutter', roles.surface.editorGutter);
  set('--r-surface-overlay', roles.surface.overlay);
  set('--r-accent-default', roles.accent.default);
  set('--r-accent-strong', roles.accent.strong);
  set('--r-accent-muted', roles.accent.muted);
  set('--r-accent-soft', roles.accent.soft);
  set('--r-accent-statusbar', roles.accent.statusbar);
  set('--r-text-primary', roles.text.primary);
}
