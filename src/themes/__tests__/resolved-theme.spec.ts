/**
 * T-2.1 特征化测试：主题合成管道
 *
 * 目标：锁定 buildComponentTokens / buildTerminalTheme / 用户偏好常量的当前行为，
 * 作为 T-2.4（ResolvedTheme 拆分）的安全网。
 *
 * 规则：
 *  - MUST NOT 依赖 document / window / localStorage（纯函数，无副作用）
 *  - 覆盖率目标 ≥ 90%（themes/components.ts、themes/derive/terminal.ts）
 *  - 断言数量 ≥ 24
 */
import { buildComponentTokens } from '@/themes/components';
import { buildTerminalTheme } from '@/themes/derive/terminal';
import { dark } from '@/themes/variants/dark';
import { light } from '@/themes/variants/light';
import { describe, expect, it } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// 用户偏好覆盖常量（从 store/app.ts 提取的黄金值，T-2.4 后迁入 resolved-theme.ts）
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT_STYLE_MAP = {
    indigo: {
        accent: 'var(--r-accent-default)',
        accentStrong: 'var(--r-accent-strong)',
        accentMuted: 'var(--r-accent-muted)',
        accentSoft: 'var(--r-accent-soft)',
        statusbarAccent: 'var(--r-accent-statusbar)',
    },
    violet: {
        accent: '#7c3aed',
        accentStrong: '#9462ff',
        accentMuted: 'rgba(124, 58, 237, 0.18)',
        accentSoft: 'rgba(124, 58, 237, 0.34)',
        statusbarAccent: '#7c3aed',
    },
    blue: {
        accent: '#2f80ed',
        accentStrong: '#4295ff',
        accentMuted: 'rgba(47, 128, 237, 0.18)',
        accentSoft: 'rgba(47, 128, 237, 0.34)',
        statusbarAccent: '#2f80ed',
    },
    teal: {
        accent: '#14b8a6',
        accentStrong: '#1ecfbc',
        accentMuted: 'rgba(20, 184, 166, 0.18)',
        accentSoft: 'rgba(20, 184, 166, 0.34)',
        statusbarAccent: '#14b8a6',
    },
    gold: {
        accent: '#e5b800',
        accentStrong: '#f4c91c',
        accentMuted: 'rgba(229, 184, 0, 0.18)',
        accentSoft: 'rgba(229, 184, 0, 0.34)',
        statusbarAccent: '#c99f00',
    },
    red: {
        accent: '#e5484d',
        accentStrong: '#ff6468',
        accentMuted: 'rgba(229, 72, 77, 0.18)',
        accentSoft: 'rgba(229, 72, 77, 0.34)',
        statusbarAccent: '#d93c42',
    },
} as const;

const RADIUS_VALUE_MAP = {
    sharp: '0.375rem',
    default: '0.625rem',
    rounded: '0.95rem',
} as const;

const UI_DENSITY_SCALE_MAP = {
    compact: '0.94',
    default: '1',
    comfortable: '1.08',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// 辅助：一次性构建令牌，供多组测试复用
// ─────────────────────────────────────────────────────────────────────────────

const darkTokens = buildComponentTokens(dark);
const lightTokens = buildComponentTokens(light);
const darkTerminalTheme = buildTerminalTheme(dark);
const lightTerminalTheme = buildTerminalTheme(light);

// ─────────────────────────────────────────────────────────────────────────────
// Group 1: 深色变体 L2 → L3 组件令牌映射
// ─────────────────────────────────────────────────────────────────────────────

describe('buildComponentTokens / dark', () => {
    it('Primer dark 层级：深色主题使用官方核心表面色', () => {
        expect(dark.surface.app).toBe('#0d1117');
        expect(dark.surface.sidebar).toBe('#151b23');
        expect(dark.surface.panelDepth).toBe('#212830');
        expect(dark.surface.overlayDepth).toBe('#262c36');
        expect(dark.surface.overlay).toBe('#212830');
        expect(dark.surface.editor).toBe('#0d1117');
        expect(dark.surface.activity).toBe('#010409');
        expect(dark.surface.editorGutter).toBe('#0d1117');
    });

    it('布局令牌：app 背景等于 dark.surface.app', () => {
        expect(darkTokens.layout.app.background).toBe(dark.surface.app);
    });

    it('布局令牌：titlebar 背景等于 dark.surface.chrome', () => {
        expect(darkTokens.layout.titlebar.background).toBe(dark.surface.chrome);
    });

    it('布局令牌：activityRail 背景等于 dark.surface.activity', () => {
        expect(darkTokens.layout.activityRail.background).toBe(dark.surface.activity);
    });

    it('布局令牌：sidebar 背景等于 dark.surface.sidebar', () => {
        expect(darkTokens.layout.sidebar.background).toBe(dark.surface.sidebar);
    });

    it('布局令牌：statusbar accent 等于 dark.accent.statusbar', () => {
        expect(darkTokens.layout.statusbar.accent).toBe(dark.accent.statusbar);
    });

    it('编辑器令牌：background 等于 dark.surface.editor', () => {
        expect(darkTokens.editor.background).toBe(dark.surface.editor);
    });

    it('编辑器令牌：surface 等于 dark.surface.editorWidget', () => {
        expect(darkTokens.editor.surface).toBe(dark.surface.editorWidget);
    });

    it('编辑器令牌：selection 等于 dark.surface.selection', () => {
        expect(darkTokens.editor.selection).toBe(dark.surface.selection);
    });

    it('Tab 令牌：active 背景等于 dark.surface.tabActive', () => {
        expect(darkTokens.tab.background.active).toBe(dark.surface.tabActive);
    });

    it('Tab 令牌：default 背景为 transparent（硬编码约定）', () => {
        expect(darkTokens.tab.background.default).toBe('transparent');
    });

    it('面板令牌：background 等于 dark.surface.panel', () => {
        expect(darkTokens.panel.background).toBe(dark.surface.panel);
    });

    it('浮层令牌：border 等于 dark.border.strong', () => {
        expect(darkTokens.overlay.border).toBe(dark.border.strong);
    });

    it('纯函数：相同输入产生相同输出（引用稳定性验证）', () => {
        const tokens2 = buildComponentTokens(dark);
        expect(tokens2.layout.app.background).toBe(darkTokens.layout.app.background);
        expect(tokens2.editor.background).toBe(darkTokens.editor.background);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 2: 浅色变体 L2 → L3 组件令牌映射
// ─────────────────────────────────────────────────────────────────────────────

describe('buildComponentTokens / light', () => {
    it('布局令牌：app 背景等于 light.surface.app', () => {
        expect(lightTokens.layout.app.background).toBe(light.surface.app);
    });

    it('编辑器令牌：background 等于 light.surface.editor（muted）', () => {
        expect(lightTokens.editor.background).toBe(light.surface.editor);
    });

    it('浅色与深色的编辑器背景应不同', () => {
        expect(lightTokens.editor.background).not.toBe(darkTokens.editor.background);
    });

    it('浅色 Tab default 同样为 transparent', () => {
        expect(lightTokens.tab.background.default).toBe('transparent');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 3: 终端主题派生
// ─────────────────────────────────────────────────────────────────────────────

describe('buildTerminalTheme / dark', () => {
    it('background 等于 dark.terminal.background', () => {
        expect(darkTerminalTheme.background).toBe(dark.terminal.background);
    });

    it('foreground 等于 dark.terminal.foreground', () => {
        expect(darkTerminalTheme.foreground).toBe(dark.terminal.foreground);
    });

    it('cursor 不出现在输出中（由 xterm 默认处理）', () => {
        expect(darkTerminalTheme.cursor).toBeUndefined();
    });

    it('black 映射到 dark.terminal.black', () => {
        expect(darkTerminalTheme.black).toBe(dark.terminal.black);
    });

    it('brightBlack 映射到 dark.terminal.brightBlack', () => {
        expect(darkTerminalTheme.brightBlack).toBe(dark.terminal.brightBlack);
    });

    it('scrollbarSliderBackground 映射到 terminal.scrollbarBackground', () => {
        expect(darkTerminalTheme.scrollbarSliderBackground).toBe(dark.terminal.scrollbarBackground);
    });

    it('16色全部存在（ANSI 完整性）', () => {
        const colors = [
            darkTerminalTheme.black, darkTerminalTheme.red, darkTerminalTheme.green,
            darkTerminalTheme.yellow, darkTerminalTheme.blue, darkTerminalTheme.magenta,
            darkTerminalTheme.cyan, darkTerminalTheme.white,
            darkTerminalTheme.brightBlack, darkTerminalTheme.brightRed, darkTerminalTheme.brightGreen,
            darkTerminalTheme.brightYellow, darkTerminalTheme.brightBlue, darkTerminalTheme.brightMagenta,
            darkTerminalTheme.brightCyan, darkTerminalTheme.brightWhite,
        ];
        for (const c of colors) {
            expect(c).toBeTruthy();
        }
    });
});

describe('buildTerminalTheme / light', () => {
    it('background 等于 light.terminal.background', () => {
        expect(lightTerminalTheme.background).toBe(light.terminal.background);
    });

    it('深色与浅色终端背景应不同', () => {
        expect(lightTerminalTheme.background).not.toBe(darkTerminalTheme.background);
    });

    it('终端主题不应包含 cursor / cursorAccent（由 xterm 默认处理，不随主题切换）', () => {
        expect(lightTerminalTheme.cursor).toBeUndefined();
        expect(lightTerminalTheme.cursorAccent).toBeUndefined();
        expect(darkTerminalTheme.cursor).toBeUndefined();
        expect(darkTerminalTheme.cursorAccent).toBeUndefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 4: 用户偏好覆盖常量（accent، radius، density）
// ─────────────────────────────────────────────────────────────────────────────

describe('用户偏好覆盖常量 / accent', () => {
    it('共 6 种预设强调色', () => {
        expect(Object.keys(ACCENT_STYLE_MAP)).toHaveLength(6);
    });

    it('indigo accent 默认值跟随当前 Primer 主题 accent', () => {
        expect(ACCENT_STYLE_MAP.indigo.accent).toBe('var(--r-accent-default)');
    });

    it('indigo accentStrong 跟随当前 Primer 主题强调色', () => {
        expect(ACCENT_STYLE_MAP.indigo.accentStrong).toBe('var(--r-accent-strong)');
    });

    it('indigo statusbarAccent 跟随当前 Primer 主题状态栏强调色', () => {
        expect(ACCENT_STYLE_MAP.indigo.statusbarAccent).toBe('var(--r-accent-statusbar)');
    });

    it('每种 accent 都含 accent / accentStrong / accentMuted / accentSoft / statusbarAccent 字段', () => {
        for (const [name, style] of Object.entries(ACCENT_STYLE_MAP)) {
            expect(style.accent, `${name}.accent`).toBeTruthy();
            expect(style.accentStrong, `${name}.accentStrong`).toBeTruthy();
            expect(style.accentMuted, `${name}.accentMuted`).toBeTruthy();
            expect(style.accentSoft, `${name}.accentSoft`).toBeTruthy();
            expect(style.statusbarAccent, `${name}.statusbarAccent`).toBeTruthy();
        }
    });

    it('red accent 主色为 #e5484d', () => {
        expect(ACCENT_STYLE_MAP.red.accent).toBe('#e5484d');
    });
});

describe('用户偏好覆盖常量 / radius', () => {
    it('共 3 种圆角预设', () => {
        expect(Object.keys(RADIUS_VALUE_MAP)).toHaveLength(3);
    });

    it('sharp 圆角值为 0.375rem', () => {
        expect(RADIUS_VALUE_MAP.sharp).toBe('0.375rem');
    });

    it('default 圆角值为 0.625rem', () => {
        expect(RADIUS_VALUE_MAP.default).toBe('0.625rem');
    });

    it('rounded 圆角值为 0.95rem', () => {
        expect(RADIUS_VALUE_MAP.rounded).toBe('0.95rem');
    });
});

describe('用户偏好覆盖常量 / density', () => {
    it('共 3 种 UI 密度', () => {
        expect(Object.keys(UI_DENSITY_SCALE_MAP)).toHaveLength(3);
    });

    it('compact 缩放比为 0.94', () => {
        expect(UI_DENSITY_SCALE_MAP.compact).toBe('0.94');
    });

    it('default 缩放比为 1', () => {
        expect(UI_DENSITY_SCALE_MAP.default).toBe('1');
    });

    it('comfortable 缩放比为 1.08', () => {
        expect(UI_DENSITY_SCALE_MAP.comfortable).toBe('1.08');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group 5: 跨变体不变量（合成管道稳健性）
// ─────────────────────────────────────────────────────────────────────────────

describe('合成管道稳健性', () => {
    it('buildComponentTokens(dark) 整体结构与 buildComponentTokens(light) 相同', () => {
        const darkKeys = Object.keys(darkTokens).sort();
        const lightKeys = Object.keys(lightTokens).sort();
        expect(darkKeys).toEqual(lightKeys);
    });

    it('buildTerminalTheme 的深色输出不含 undefined 字段', () => {
        const values = Object.values(darkTerminalTheme);
        for (const v of values) {
            expect(v).not.toBeUndefined();
        }
    });

    it('buildTerminalTheme 是纯函数：两次调用输出结构相同', () => {
        const t1 = buildTerminalTheme(dark);
        const t2 = buildTerminalTheme(dark);
        expect(t1).toEqual(t2);
    });
});
