/**
 * 主题合成管道单元测试
 *
 * 覆盖三条纯函数管道：
 *  - buildComponentTokens：L2 变体 → L3 组件令牌映射
 *  - buildTerminalTheme：变体 → 终端 ANSI 主题派生
 *  - 用户偏好覆盖常量（accent / radius / density）契约
 *
 * 约束：被测对象均为纯函数，断言不得依赖 document / window / localStorage。
 */

import { describe, expect, it } from 'vitest';
import { buildTerminalTheme } from '@/themes/derive/terminal';
import {
  ACCENT_STYLE_MAP,
  RADIUS_VALUE_MAP,
  UI_DENSITY_SCALE_MAP,
} from '@/themes/runtime/resolved-theme';
import { buildComponentTokens } from '@/themes/tokens/components';
import { dark } from '@/themes/variants/dark';
import { light } from '@/themes/variants/light';

// 一次性构建令牌，供多组测试复用（纯函数，可安全共享）。
const darkTokens = buildComponentTokens(dark);
const lightTokens = buildComponentTokens(light);
const darkTerminalTheme = buildTerminalTheme(dark);
const lightTerminalTheme = buildTerminalTheme(light);

// ── Group 1: 深色变体 L2 → L3 组件令牌映射 ──
describe('buildComponentTokens / dark', () => {
  it('Primer dark 层级：深色主题使用官方核心表面色', () => {
    expect(dark.surface.app).toBe('#0d1117');
    expect(dark.surface.sidebar).toBe('#151b23');
    expect(dark.surface.panelDepth).toBe('#FAFAFA');
    expect(dark.surface.overlayDepth).toBe('#262c36');
    expect(dark.surface.overlay).toBe('#FAFAFA');
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

// ── Group 2: 浅色变体 L2 → L3 组件令牌映射 ──
describe('buildComponentTokens / light', () => {
  it('布局令牌：app 背景等于 light.surface.app', () => {
    expect(lightTokens.layout.app.background).toBe(light.surface.app);
  });

  it('编辑器令牌：background 等于 light.surface.editor', () => {
    expect(lightTokens.editor.background).toBe(light.surface.editor);
  });

  it('浅色编辑器背景使用纯白', () => {
    expect(lightTokens.editor.background).toBe('#ffffff');
    expect(lightTokens.editor.gutter).toBe('#ffffff');
  });

  it('浅色底部面板与 tab 背景使用纯白', () => {
    expect(lightTokens.panel.background).toBe('#ffffff');
    expect(lightTokens.layout.tabbar.background).toBe('#ffffff');
    expect(lightTokens.tab.background.active).toBe('#ffffff');
  });

  it('浅色与深色的编辑器背景应不同', () => {
    expect(lightTokens.editor.background).not.toBe(darkTokens.editor.background);
  });

  it('浅色 Tab default 同样为 transparent', () => {
    expect(lightTokens.tab.background.default).toBe('transparent');
  });

  it('Git Diff 新增与删除背景使用浅色令牌', () => {
    expect(lightTokens.diff.addedSubtle).toBe('#e7f4e7');
    expect(lightTokens.diff.deletedSubtle).toBe('#fbe6e2');
  });
});

// ── Group 3: 终端主题派生 ──
describe('buildTerminalTheme / dark', () => {
  it('background 等于 dark.terminal.background', () => {
    expect(darkTerminalTheme.background).toBe(dark.terminal.background);
  });

  it('foreground 等于 dark.terminal.foreground', () => {
    expect(darkTerminalTheme.foreground).toBe(dark.terminal.foreground);
  });

  it('cursor 映射到 dark.terminal.cursor', () => {
    expect(darkTerminalTheme.cursor).toBe(dark.terminal.cursor);
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

  it('16 色全部存在（ANSI 完整性）', () => {
    const colors = [
      darkTerminalTheme.black,
      darkTerminalTheme.red,
      darkTerminalTheme.green,
      darkTerminalTheme.yellow,
      darkTerminalTheme.blue,
      darkTerminalTheme.magenta,
      darkTerminalTheme.cyan,
      darkTerminalTheme.white,
      darkTerminalTheme.brightBlack,
      darkTerminalTheme.brightRed,
      darkTerminalTheme.brightGreen,
      darkTerminalTheme.brightYellow,
      darkTerminalTheme.brightBlue,
      darkTerminalTheme.brightMagenta,
      darkTerminalTheme.brightCyan,
      darkTerminalTheme.brightWhite,
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

  it('浅色终端前景色使用终端专用文字色', () => {
    expect(lightTerminalTheme.foreground).toBe('#1a1c1f');
  });

  it('深色与浅色终端背景应不同', () => {
    expect(lightTerminalTheme.background).not.toBe(darkTerminalTheme.background);
  });

  it('浅色终端光标使用黑色', () => {
    expect(lightTerminalTheme.cursor).toBe('#000000');
    expect(lightTerminalTheme.cursorAccent).toBe('#ffffff');
  });
});

// ── Group 4: 用户偏好覆盖常量（直接校验生产模块导出，而非测试内副本）──
describe('用户偏好覆盖常量 / accent', () => {
  const accentNames = ['indigo', 'violet', 'blue', 'teal', 'gold', 'red'] as const;
  const accentFields = ['accent', 'accentMuted', 'accentSoft', 'accentStrong', 'statusbarAccent'];

  it('恰好提供 6 种预设强调色', () => {
    expect(Object.keys(ACCENT_STYLE_MAP).sort()).toEqual([...accentNames].sort());
  });

  it('每种强调色都包含全部 5 个 CSS 字段且取值非空', () => {
    for (const name of accentNames) {
      const style = ACCENT_STYLE_MAP[name];
      expect(Object.keys(style).sort()).toEqual([...accentFields].sort());
      for (const [field, value] of Object.entries(style)) {
        expect(value, `${name}.${field}`).toBeTruthy();
      }
    }
  });

  it('indigo 预设跟随 Primer 主题 CSS 变量而非硬编码色值', () => {
    expect(ACCENT_STYLE_MAP.indigo.accent).toBe('var(--r-accent-default)');
    expect(ACCENT_STYLE_MAP.indigo.accentStrong).toBe('var(--r-accent-strong)');
    expect(ACCENT_STYLE_MAP.indigo.statusbarAccent).toBe('var(--r-accent-statusbar)');
  });

  it('自定义强调色使用确定的十六进制主色', () => {
    expect(ACCENT_STYLE_MAP.red.accent).toBe('#e5484d');
    expect(ACCENT_STYLE_MAP.blue.accent).toBe('#2f80ed');
    expect(ACCENT_STYLE_MAP.teal.accent).toBe('#14b8a6');
  });
});

describe('用户偏好覆盖常量 / radius', () => {
  it('提供 sharp/default/rounded 三档圆角', () => {
    expect(Object.keys(RADIUS_VALUE_MAP)).toEqual(['sharp', 'default', 'rounded']);
  });

  it('圆角半径随档位单调递增', () => {
    const rem = (value: string) => Number.parseFloat(value);
    expect(rem(RADIUS_VALUE_MAP.sharp)).toBeLessThan(rem(RADIUS_VALUE_MAP.default));
    expect(rem(RADIUS_VALUE_MAP.default)).toBeLessThan(rem(RADIUS_VALUE_MAP.rounded));
  });
});

describe('用户偏好覆盖常量 / density', () => {
  it('提供 compact/default/comfortable 三档密度', () => {
    expect(Object.keys(UI_DENSITY_SCALE_MAP)).toEqual(['compact', 'default', 'comfortable']);
  });

  it('密度缩放比满足 compact < default(=1) < comfortable', () => {
    expect(Number(UI_DENSITY_SCALE_MAP.default)).toBe(1);
    expect(Number(UI_DENSITY_SCALE_MAP.compact)).toBeLessThan(1);
    expect(Number(UI_DENSITY_SCALE_MAP.comfortable)).toBeGreaterThan(1);
  });
});

// ── Group 5: 跨变体不变量（合成管道稳健性）──
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
