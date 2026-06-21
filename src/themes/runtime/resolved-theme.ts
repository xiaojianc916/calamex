/**
 * src/themes/runtime/resolved-theme.ts
 * 用户偏好覆盖常量与派生类型（T-2.4）
 *
 * 职责：
 *  - 持有与用户偏好相关的样式映射常量（accent、radius、density）
 *  - 提供 buildAccentCssVars / buildUserOverrideCssVars 纯函数，返回 CSS 变量 map
 *  - 不持有 Vue 响应式对象，不写 DOM，不 import store
 *
 * 消费者：
 *  - src/themes/runtime/effects.ts（唯一 DOM 写入出口）
 *  - src/store/app.ts（仅读常量，无 DOM 操作）
 *  - src/themes/__tests__/*.spec.ts（测试用）
 */
import type { TAccentColor, TRadiusPreset, TUiDensity } from '@/types/app';

// ─────────────────────────────────────────────────────────────────────────────
// 用户偏好覆盖常量（单源，原来分散在 store/app.ts + 测试文件中）
// ─────────────────────────────────────────────────────────────────────────────

/** 各强调色预设对应的 CSS 变量值 */
export const ACCENT_STYLE_MAP: Record<
  TAccentColor,
  {
    accent: string;
    accentStrong: string;
    accentMuted: string;
    accentSoft: string;
    statusbarAccent: string;
  }
> = {
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
};

/** 各圆角预设对应的 CSS 值 */
export const RADIUS_VALUE_MAP: Record<TRadiusPreset, string> = {
  sharp: '0.375rem',
  default: '0.625rem',
  rounded: '0.95rem',
};

/** 各 UI 密度对应的缩放比 */
export const UI_DENSITY_SCALE_MAP: Record<TUiDensity, string> = {
  compact: '0.94',
  default: '1',
  comfortable: '1.08',
};

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：生成用户偏好对应的 CSS 变量 map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 给定用户选择的强调色，返回对应 CSS 变量 key-value 对。
 * 纯函数：无副作用，不写 DOM。
 */
function buildAccentCssVars(accentColor: TAccentColor): Record<string, string> {
  const s = ACCENT_STYLE_MAP[accentColor];
  return {
    '--accent': s.accent,
    '--accent-strong': s.accentStrong,
    '--accent-muted': s.accentMuted,
    '--settings-accent': s.accent,
    '--settings-accent-soft': s.accentSoft,
    '--settings-accent-muted': s.accentMuted,
    '--statusbar-accent': s.statusbarAccent,
  };
}

/**
 * 给定用户完整的外观偏好，返回所有需要覆盖的 CSS 变量 key-value 对。
 * 纯函数：无副作用，不写 DOM。
 */
export function buildUserOverrideCssVars(opts: {
  accentColor: TAccentColor;
  radiusPreset: TRadiusPreset;
  uiDensity: TUiDensity;
  interfaceFontSize: number;
}): Record<string, string> {
  return {
    ...buildAccentCssVars(opts.accentColor),
    '--radius': RADIUS_VALUE_MAP[opts.radiusPreset],
    '--app-ui-font-size': `${opts.interfaceFontSize}px`,
    '--app-density-scale': UI_DENSITY_SCALE_MAP[opts.uiDensity],
  };
}
