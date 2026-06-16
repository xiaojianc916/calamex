/**
 * L3 Components — 组件令牌构造函数
 *
 * 规则：
 *  - 此文件是纯函数，不 import primitives，只接受 IRoles 参数
 *  - 所有令牌值必须通过 roles 参数引用，禁止写颜色字面量
 *  - 命名维度：<component>.<slot>[.<state>]
 *  - IComponentTokens 类型由 ReturnType 推导，不手工维护
 */
import type { IRoles } from './types';

/**
 * 从 L2 语义角色派生 L3 组件令牌。
 * 纯函数：相同输入 → 完全相同输出。
 */
export function buildComponentTokens(roles: IRoles) {
  return {
    // ── 布局区域 ──────────────────────────────────────────────────────────────
    layout: {
      app: {
        background: roles.surface.app,
      },
      titlebar: {
        background: roles.surface.chrome,
      },
      activityRail: {
        background: roles.surface.activity,
      },
      sidebar: {
        background: roles.surface.sidebar,
      },
      statusbar: {
        background: roles.surface.chrome,
        accent: roles.accent.statusbar,
      },
      tabbar: {
        background: roles.surface.tabbar,
      },
    },

    // ── 代码编辑器 ────────────────────────────────────────────────────────────
    editor: {
      background: roles.surface.editor,
      gutter: roles.surface.editorGutter,
      /** 内嵌 Widget 背景（悬浮提示、补全框、标题查找等） */
      surface: roles.surface.editorWidget,
      lineHighlight: roles.surface.soft,
      selection: roles.surface.selection,
      inactiveSelection: roles.surface.hover,
    },

    // ── Tab ────────────────────────────────────────────────────────────────────
    tab: {
      background: {
        default: 'transparent',
        active: roles.surface.tabActive,
        hover: roles.surface.tabHover,
      },
    },

    // ── 底部面板（终端区） ─────────────────────────────────────────────────────
    panel: {
      background: roles.surface.panel,
      backgroundDepth: roles.surface.panelDepth,
    },

    // ── 浮层（菜单、下拉、Popover）───────────────────────────────────────────
    overlay: {
      background: roles.surface.overlay,
      backgroundDepth: roles.surface.overlayDepth,
      border: roles.border.strong,
      separator: roles.border.divider,
    },

    // ── 通用交互遮罩 ──────────────────────────────────────────────────────────
    surface: {
      hover: roles.surface.hover,
      soft: roles.surface.soft,
      softStrong: roles.surface.softStrong,
    },

    // ── 文字 ──────────────────────────────────────────────────────────────────
    text: {
      primary: roles.text.primary,
      secondary: roles.text.secondary,
      tertiary: roles.text.tertiary,
      quaternary: roles.text.quaternary,
      onAccent: roles.text.onAccent,
      placeholder: roles.text.placeholder,
    },

    // ── 边框 ──────────────────────────────────────────────────────────────────
    border: {
      subtle: roles.border.subtle,
      strong: roles.border.strong,
      divider: roles.border.divider,
    },

    // ── 品牌强调色 ────────────────────────────────────────────────────────────
    accent: {
      default: roles.accent.default,
      strong: roles.accent.strong,
      muted: roles.accent.muted,
      soft: roles.accent.soft,
      statusbar: roles.accent.statusbar,
    },

    // ── 语义状态色 ────────────────────────────────────────────────────────────
    status: {
      success: roles.status.success,
      successMuted: roles.status.successMuted,
      warning: roles.status.warning,
      warningMuted: roles.status.warningMuted,
      danger: roles.status.danger,
      dangerMuted: roles.status.dangerMuted,
      info: roles.status.info,
      infoMuted: roles.status.infoMuted,
    },

    // ── 语法高亮 ──────────────────────────────────────────────────────────────
    syntax: {
      comment: roles.syntax.comment,
      keyword: roles.syntax.keyword,
      string: roles.syntax.string,
      number: roles.syntax.number,
      delimiter: roles.syntax.delimiter,
      variable: roles.syntax.variable,
      type: roles.syntax.type,
      operator: roles.syntax.operator,
      cursor: roles.syntax.cursor,
      lineNumber: roles.syntax.lineNumber,
      lineNumberActive: roles.syntax.lineNumberActive,
    },

    // ── Diff / Git ─────────────────────────────────────────────────────────────
    diff: {
      modified: roles.diff.modified,
      added: roles.diff.added,
      deleted: roles.diff.deleted,
      addedSubtle: roles.diff.addedSubtle,
      deletedSubtle: roles.diff.deletedSubtle,
      modifiedSubtle: roles.diff.modifiedSubtle,
      divider: roles.diff.divider,
    },
  } as const;
}
