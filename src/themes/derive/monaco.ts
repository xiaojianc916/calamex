/**
 * Deriver: Monaco Editor Theme
 *
 * 从 L2 Roles + L3 ComponentTokens 构造 Monaco StandaloneThemeData。
 * 纯函数：相同输入 → 完全相同输出。
 *
 * 规则：
 *  - 不 import primitives，不写颜色字面量（只允许 alpha 操作辅助函数）
 *  - 派生器签名遵循规范：buildMonacoTheme(roles, tokens, options)
 */
import type { IComponentTokens, IRoles } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────────────────────

/** 去掉 CSS 颜色字符串中的 `#` 前缀，供 Monaco rules[].foreground 使用 */
const noHash = (color: string): string => color.replace(/^#/, '');

/**
 * 将一个 6 位 hex 颜色叠加指定 alpha（2 位 hex），返回 8 位 hex。
 * 仅用于 Monaco colors 对象（不用于 rules）。
 * @example withAlpha('#dcdee0', '45') → '#dcdee045'
 */
const withAlpha = (hex6: string, alphaHex: string): string => `${hex6}${alphaHex}`;

/**
 * 将任意 CSS 颜色字符串转换为 Monaco parseHex 能接受的格式。
 * Monaco 只接受 `#rrggbb` / `#rrggbbaa`，rgba()/rgb() 会导致 parseHex 崩溃。
 */
const toMonacoHex = (color: string): string => {
    if (!color) return '#00000000';
    const s = color.trim();
    if (s.startsWith('#')) return s;
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    if (m) {
        const r = parseInt(m[1], 10).toString(16).padStart(2, '0');
        const g = parseInt(m[2], 10).toString(16).padStart(2, '0');
        const b = parseInt(m[3], 10).toString(16).padStart(2, '0');
        const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
        const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}${a}`;
    }
    return '#00000000';
};

/** 批量将 colors 对象中所有值转为 Monaco 兼容的十六进制格式 */
const sanitizeMonacoColors = (colors: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(colors)) {
        out[k] = toMonacoHex(v);
    }
    return out;
};

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

interface IMonacoTokenRule {
    token: string;
    foreground?: string;
    fontStyle?: string;
}

interface IMonacoThemeDefinition {
    base: 'vs-dark' | 'vs';
    inherit: boolean;
    rules: IMonacoTokenRule[];
    colors: Record<string, string>;
}

export interface IMonacoThemeMap {
    dark: IMonacoThemeDefinition;
    light: IMonacoThemeDefinition;
}

interface IMonacoThemeOptions {
    /** 当前渲染模式 */
    mode: 'dark' | 'light';
}

// ─────────────────────────────────────────────────────────────────────────────
// 公开派生器
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造单个 Monaco 主题定义。
 * 在 manager 切换流水线中为每个 variant 各调用一次。
 */
export function buildMonacoTheme(
    roles: IRoles,
    tokens: IComponentTokens,
    options: IMonacoThemeOptions,
): IMonacoThemeDefinition {
    const isDark = options.mode === 'dark';

    const rules: IMonacoTokenRule[] = [
        { token: 'comment', foreground: noHash(tokens.syntax.comment), fontStyle: isDark ? 'italic' : undefined },
        { token: 'keyword', foreground: noHash(tokens.syntax.keyword) },
        { token: 'string', foreground: noHash(tokens.syntax.string) },
        { token: 'number', foreground: noHash(tokens.syntax.number) },
        { token: 'delimiter', foreground: noHash(tokens.syntax.delimiter) },
    ];

    if (isDark) {
        rules.push(
            { token: 'variable', foreground: noHash(tokens.syntax.variable) },
            { token: 'type', foreground: noHash(tokens.syntax.type) },
            { token: 'function', foreground: noHash(tokens.syntax.type) },
            { token: 'operator', foreground: noHash(tokens.syntax.operator) },
        );
    }

    return {
        base: isDark ? 'vs-dark' : 'vs',
        inherit: true,
        rules,
        colors: sanitizeMonacoColors(buildMonacoColors(roles, tokens, isDark)),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monaco colors 映射（内部）
// ─────────────────────────────────────────────────────────────────────────────

function buildMonacoColors(
    roles: IRoles,
    tokens: IComponentTokens,
    isDark: boolean,
): Record<string, string> {
    const accent = tokens.accent.strong;
    const accentBase = tokens.accent.default;
    const editorBg = tokens.editor.background;
    const editorGutterBg = tokens.editor.gutter;
    const widgetBg = tokens.editor.surface;
    const overlayBg = tokens.overlay.background;
    const overlayDepth = tokens.overlay.backgroundDepth;
    const fgPrimary = tokens.text.primary;
    const fgSecondary = tokens.text.secondary;
    const fgTertiary = tokens.text.tertiary;
    const fgQuaternary = tokens.text.quaternary;
    const selection = tokens.editor.selection;
    const borderWeak = tokens.overlay.border;
    const borderSep = tokens.overlay.separator;
    const btnBg = isDark ? tokens.accent.statusbar : tokens.accent.strong;
    const diffInsertedBackground = tokens.diff.addedSubtle;
    const diffRemovedBackground = tokens.diff.deletedSubtle;

    return {
        // ── 全局 ──
        focusBorder: accent,
        foreground: fgPrimary,
        descriptionForeground: fgTertiary,
        disabledForeground: fgQuaternary,
        errorForeground: tokens.status.danger,
        'icon.foreground': fgSecondary,
        'selection.background': selection,
        'sash.hoverBorder': tokens.diff.divider,
        'widget.shadow': isDark ? '#0308146b' : '#0f172a1f',
        'scrollbar.shadow': '#00000000',

        // ── 滚动条 ──
        'scrollbarSlider.background': roles.terminal.scrollbarBackground,
        'scrollbarSlider.hoverBackground': roles.terminal.scrollbarHoverBackground,
        'scrollbarSlider.activeBackground': roles.terminal.scrollbarActiveBackground,

        // ── Badge / Progress ──
        'badge.background': isDark ? '#273b85' : accentBase,
        'badge.foreground': fgPrimary,
        'progressBar.background': accent,

        // ── List ──
        'list.hoverBackground': tokens.surface.hover,
        'list.hoverForeground': fgPrimary,
        'list.activeSelectionBackground': selection,
        'list.activeSelectionForeground': fgPrimary,
        'list.inactiveSelectionBackground': tokens.surface.soft,
        'list.inactiveSelectionForeground': fgSecondary,
        'list.focusBackground': selection,
        'list.focusForeground': fgPrimary,
        'list.highlightForeground': isDark ? tokens.accent.strong : accentBase,
        'list.dropBackground': withAlpha(accentBase, '38'),

        // ── 菜单 ──
        'menu.background': overlayBg,
        'menu.foreground': fgSecondary,
        'menu.selectionBackground': tokens.accent.muted,
        'menu.selectionForeground': isDark ? tokens.text.onAccent : fgPrimary,
        'menu.selectionBorder': '#00000000',
        'menu.separatorBackground': borderSep,
        'menu.border': borderWeak,

        // ── Editor Action List ──
        'editorActionList.background': overlayBg,
        'editorActionList.foreground': fgSecondary,
        'editorActionList.focusBackground': tokens.accent.muted,
        'editorActionList.focusForeground': isDark ? tokens.text.onAccent : fgPrimary,

        // ── 编辑器 ──
        'editor.background': editorBg,
        'editor.foreground': fgPrimary,
        'editorLineNumber.foreground': tokens.syntax.lineNumber,
        'editorLineNumber.activeForeground': tokens.syntax.lineNumberActive,
        'editorCursor.foreground': tokens.syntax.cursor,
        'editor.selectionBackground': withAlpha(accentBase, isDark ? '42' : '2e'),
        'editor.inactiveSelectionBackground': withAlpha(accentBase, isDark ? '2a' : '1c'),
        'editor.selectionHighlightBackground': isDark ? '#ffffff0d' : '#0f172a0c',
        'editor.wordHighlightBackground': isDark ? '#ffffff12' : '#0f172a12',
        'editor.wordHighlightStrongBackground': withAlpha(accentBase, isDark ? '26' : '20'),
        'editor.rangeHighlightBackground': isDark ? '#ffffff08' : '#0f172a08',
        'editor.findMatchBackground': withAlpha(accent, isDark ? '40' : '29'),
        'editor.findMatchBorder': withAlpha(accent, isDark ? '7d' : '66'),
        'editor.findMatchHighlightBackground': isDark ? '#ffffff12' : '#0f172a10',
        'editor.findRangeHighlightBackground': withAlpha(accentBase, isDark ? '18' : '12'),
        'editor.lineHighlightBackground': isDark ? '#ffffff08' : '#0f172a06',
        'editor.lineHighlightBorder': '#00000000',
        'editorLink.activeForeground': isDark ? tokens.accent.strong : accentBase,
        'editorWhitespace.foreground': isDark ? '#ffffff20' : '#0f172a24',
        'editorIndentGuide.background1': isDark ? '#ffffff14' : '#0f172a14',
        'editorIndentGuide.activeBackground1': isDark ? '#ffffff24' : '#0f172a26',
        'editorBracketMatch.background': withAlpha(accentBase, isDark ? '18' : '12'),
        'editorBracketMatch.border': withAlpha(accent, isDark ? '73' : '59'),
        'editor.foldBackground': withAlpha(accentBase, isDark ? '1f' : '12'),
        'editorGutter.background': editorGutterBg,
        'editorGutter.modifiedBackground': tokens.diff.modified,
        'editorGutter.addedBackground': tokens.diff.added,
        'editorGutter.deletedBackground': tokens.diff.deleted,
        'diffEditor.insertedLineBackground': diffInsertedBackground,
        'diffEditor.insertedTextBackground': diffInsertedBackground,
        'diffEditor.removedLineBackground': diffRemovedBackground,
        'diffEditor.removedTextBackground': diffRemovedBackground,

        // ── Overview Ruler ──
        'editorOverviewRuler.border': '#00000000',
        'editorOverviewRuler.errorForeground': withAlpha(tokens.status.danger, isDark ? '70' : '55'),
        'editorOverviewRuler.warningForeground': withAlpha(tokens.status.warning, isDark ? '66' : '55'),
        'editorOverviewRuler.infoForeground': withAlpha(accent, isDark ? '66' : '4d'),

        // ── 诊断 ──
        'editorError.foreground': tokens.status.danger,
        'editorWarning.foreground': tokens.status.warning,
        'editorInfo.foreground': accent,
        'editorHint.foreground': fgTertiary,
        'editorLightBulb.foreground': tokens.status.warning,
        'editorLightBulbAutoFix.foreground': accent,

        // ── Widget / Suggest ──
        'editorWidget.background': widgetBg,
        'editorWidget.foreground': fgPrimary,
        'editorWidget.border': borderWeak,
        'editorSuggestWidget.background': widgetBg,
        'editorSuggestWidget.border': borderWeak,
        'editorSuggestWidget.foreground': fgPrimary,
        'editorSuggestWidget.selectedBackground': selection,
        'editorSuggestWidget.selectedForeground': fgPrimary,
        'editorSuggestWidget.highlightForeground': isDark ? tokens.accent.strong : accentBase,
        'editorSuggestWidget.focusHighlightForeground': isDark ? tokens.accent.strong : accentBase,
        'editorSuggestWidgetStatus.foreground': fgTertiary,

        // ── Hover Widget ──
        'editorHoverWidget.background': widgetBg,
        'editorHoverWidget.foreground': fgPrimary,
        'editorHoverWidget.border': borderWeak,
        'editorHoverWidget.statusBarBackground': overlayDepth,
        'editorHoverWidget.highlightForeground': isDark ? tokens.accent.strong : accentBase,

        // ── Marker Navigation ──
        'editorMarkerNavigation.background': widgetBg,
        'editorMarkerNavigationError.background': tokens.status.dangerMuted,
        'editorMarkerNavigationError.headerBackground': isDark ? '#4f1e29' : '#ffdbe3',
        'editorMarkerNavigationWarning.background': tokens.status.warningMuted,
        'editorMarkerNavigationWarning.headerBackground': isDark ? '#59481b' : '#ffe7b2',
        'editorMarkerNavigationInfo.background': tokens.status.infoMuted,
        'editorMarkerNavigationInfo.headerBackground': isDark ? '#23306d' : '#dbe7ff',
        'editorMarkerNavigationError.heading': isDark ? '#ff8d98' : tokens.status.danger,
        'editorMarkerNavigationWarning.heading': isDark ? '#f6d885' : tokens.status.warning,
        'editorMarkerNavigationInfo.heading': isDark ? tokens.accent.strong : accentBase,

        // ── Peek View ──
        'peekView.border': withAlpha(accent, '45'),
        'peekViewEditor.background': widgetBg,
        'peekViewEditor.matchHighlightBackground': withAlpha(accentBase, '28'),
        'peekViewResult.background': overlayDepth,
        'peekViewResult.selectionBackground': selection,
        'peekViewResult.selectionForeground': fgPrimary,
        'peekViewTitle.background': overlayDepth,
        'peekViewTitleLabel.foreground': fgPrimary,
        'peekViewTitleDescription.foreground': fgTertiary,

        // ── Input ──
        'input.background': overlayDepth,
        'input.foreground': fgPrimary,
        'input.border': borderWeak,
        'input.placeholderForeground': fgQuaternary,
        'inputOption.activeBorder': accent,
        'inputOption.activeBackground': withAlpha(accentBase, '26'),
        'inputOption.activeForeground': fgPrimary,
        'inputValidation.infoBackground': tokens.status.infoMuted,
        'inputValidation.infoBorder': withAlpha(accent, '45'),
        'inputValidation.warningBackground': tokens.status.warningMuted,
        'inputValidation.warningBorder': withAlpha(tokens.status.warning, '55'),
        'inputValidation.errorBackground': tokens.status.dangerMuted,
        'inputValidation.errorBorder': withAlpha(tokens.status.danger, '66'),

        // ── Quick Input ──
        'quickInput.background': widgetBg,
        'quickInput.foreground': fgPrimary,
        'quickInputTitle.background': overlayDepth,
        'quickInputList.focusBackground': selection,
        'quickInputList.focusForeground': fgPrimary,
        'pickerGroup.foreground': fgTertiary,
        'pickerGroup.border': borderSep,

        // ── Keybinding Label ──
        'keybindingLabel.background': overlayDepth,
        'keybindingLabel.foreground': fgSecondary,
        'keybindingLabel.border': borderWeak,
        'keybindingLabel.bottomBorder': borderSep,

        // ── Button ──
        'button.background': btnBg,
        'button.foreground': tokens.text.onAccent,
        'button.hoverBackground': isDark ? tokens.accent.strong : tokens.accent.statusbar,
        'button.secondaryBackground': selection,
        'button.secondaryForeground': fgPrimary,
        'button.secondaryHoverBackground': isDark ? '#262c35' : '#e2e8f0',

        // ── Misc ──
        'textCodeBlock.background': overlayDepth,
    };
}
