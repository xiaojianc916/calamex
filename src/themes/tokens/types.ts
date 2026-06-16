/**
 * L2 / L3 类型声明
 *
 * - IRoles：所有主题变体必须严格实现的语义角色契约
 * - IComponentTokens：由 buildComponentTokens 推导的组件令牌类型
 * - IThemeVariant：变体注册表条目
 * - TVariantId：受约束的变体标识符字面量
 */
import type { buildComponentTokens } from './components';

// ─────────────────────────────────────────────────────────────────────────────
// IRoles — L2 语义角色契约
// ─────────────────────────────────────────────────────────────────────────────
// 规则：
//  - 所有字段类型为 string（CSS 颜色表达式）
//  - 只允许嵌套对象结构，不允许数组或其他类型
//  - 角色名描述"用途/状态"，不出现具体组件名（tab、button 等）
//  - 每个变体必须完整实现此接口，不允许添加私有字段

export interface IRoles {
  /** 结构层次表面 */
  surface: {
    /** 应用最外层背景 */
    app: string;
    /** IDE Chrome（标题栏、状态栏共享基调） */
    chrome: string;
    /** 活动栏/活动轨背景 */
    activity: string;
    /** 侧边栏面板背景 */
    sidebar: string;
    /** 代码编辑器背景 */
    editor: string;
    /** 代码编辑器装订线 / 行号区背景 */
    editorGutter: string;
    /** 编辑器内嵌 Widget（悬浮提示、补全框等） */
    editorWidget: string;
    /** 底部面板（终端区）背景 */
    panel: string;
    /** 面板次级背景（更深一级） */
    panelDepth: string;
    /** Tab 栏背景 */
    tabbar: string;
    /** 活动 Tab 背景 */
    tabActive: string;
    /** 悬浮 Tab 背景 */
    tabHover: string;
    /** 浮层背景（菜单、下拉、Popover） */
    overlay: string;
    /** 浮层次级背景（组内标题、分组头） */
    overlayDepth: string;
    /** 悬浮交互遮罩（rgba） */
    hover: string;
    /** 低强度高亮遮罩（rgba） */
    soft: string;
    /** 中强度高亮遮罩（rgba） */
    softStrong: string;
    /** 文本 / 列表项选中背景 */
    selection: string;
  };

  /** 文字颜色 */
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    quaternary: string;
    /** 位于 accent 色背景上的文字 */
    onAccent: string;
    /** 占位符文字 */
    placeholder: string;
  };

  /** 边框与分割线 */
  border: {
    /** 几乎不可见的细边框 */
    subtle: string;
    /** 清晰可见的边框 */
    strong: string;
    /** 区域分割线 */
    divider: string;
  };

  /**
   * 品牌强调色（运行时可由用户偏好覆盖）
   * 此处提供默认 Indigo 方案，动态覆盖由 store 在 manager 之后执行
   */
  accent: {
    default: string;
    strong: string;
    /** 用于背景填充的低透明度版本 */
    muted: string;
    /** 比 muted 稍强的半透明版本 */
    soft: string;
    /** 状态栏特供 accent */
    statusbar: string;
  };

  /** 语义状态色 */
  status: {
    success: string;
    /** 用于背景填充的低饱和成功色 */
    successMuted: string;
    warning: string;
    warningMuted: string;
    danger: string;
    dangerMuted: string;
    info: string;
    infoMuted: string;
  };

  /** 语法高亮令牌颜色 */
  syntax: {
    comment: string;
    keyword: string;
    string: string;
    number: string;
    delimiter: string;
    variable: string;
    type: string;
    operator: string;
    /** 编辑器光标颜色 */
    cursor: string;
    /** 普通行号颜色 */
    lineNumber: string;
    /** 当前行行号颜色 */
    lineNumberActive: string;
  };

  /** 差异/Git 标注颜色 */
  diff: {
    modified: string;
    added: string;
    deleted: string;
    /** Gutter 背景色（低透明度） */
    addedSubtle: string;
    deletedSubtle: string;
    modifiedSubtle: string;
    /** Diff 分隔拖拽线颜色 */
    divider: string;
  };

  /** 终端（xterm）颜色 */
  terminal: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    scrollbarBackground: string;
    scrollbarHoverBackground: string;
    scrollbarActiveBackground: string;
    // ANSI 16 色
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// IComponentTokens — L3 组件令牌（由 buildComponentTokens 推导）
// ─────────────────────────────────────────────────────────────────────────────
export type IComponentTokens = ReturnType<typeof buildComponentTokens>;

// ─────────────────────────────────────────────────────────────────────────────
// 变体注册表类型
// ─────────────────────────────────────────────────────────────────────────────

/** 当前支持的主题变体标识符 */
export type TVariantId = 'dark' | 'light';

/** 主题变体注册条目 */
export interface IThemeVariant {
  id: TVariantId;
  /** 展示名称（UI 中显示） */
  label: string;
  /** 基础明暗模式（用于 html.dark 类切换等） */
  mode: 'dark' | 'light';
  /** 实现 IRoles 的语义角色对象 */
  roles: IRoles;
}

// ─────────────────────────────────────────────────────────────────────────────
// 事件
// ─────────────────────────────────────────────────────────────────────────────

/** theme-changed 自定义事件的 detail 结构 */
export interface IThemeChangedDetail {
  variantId: TVariantId;
  mode: 'dark' | 'light';
  tokens: IComponentTokens;
}

declare global {
  interface WindowEventMap {
    'theme-changed': CustomEvent<IThemeChangedDetail>;
  }
}
