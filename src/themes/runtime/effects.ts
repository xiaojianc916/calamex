/**
 * src/themes/runtime/effects.ts
 * DOM 副作用唯一出口（R-20.3.3）
 *
 * 职责：
 *  - 这是前端唯一允许向 document.documentElement 写入 CSS 变量 / dataset / classList 的地方。
 *  - store/app.ts MUST NOT 直接操作 document.*；应调用本模块的函数。
 *  - 纯粹的"效果层"：接收已计算好的设置，执行 DOM 写入，不持有状态。
 *
 * 调用方：
 *  - src/store/app.ts 内的 watch（当 settings / effectiveTheme 变化时）
 */
import type { TThemeMode } from '@/types/app';
import type { IAppSettings } from '@/types/settings';
import { getThemeManager } from '../index';
import { ACCENT_STYLE_MAP, RADIUS_VALUE_MAP, UI_DENSITY_SCALE_MAP } from './resolved-theme';

const hasDocument = (): boolean => typeof document !== 'undefined';

/**
 * 将已解析的用户设置与有效主题应用到 document root 元素。
 *
 * 执行顺序：
 *  1. 委托 ThemeManager 完成基础颜色令牌注入（CSS 变量 + html class 切换）
 *  2. 在管道结果之上叠加用户偏好覆盖（accent / radius / density / fontSize / reduceMotion）
 *
 * @param settings   当前应用设置（来自 useAppStore）
 * @param effectiveTheme  已解析的有效主题（'dark' | 'light'，system 已解析）
 */
export function applyResolvedThemeEffect(settings: IAppSettings, effectiveTheme: TThemeMode): void {
  if (!hasDocument()) return;

  const root = document.documentElement;
  if (!root) return;

  // ── 1. 基础令牌管道：ThemeManager 负责 emitCssVars + html.dark/light 切换 ──
  getThemeManager().set(effectiveTheme);

  // ── 2. 用户偏好叠加：覆盖管道产出的默认 accent 等变量 ──────────────────────
  const accentStyle = ACCENT_STYLE_MAP[settings.appearance.accentColor];

  // html 数据属性（供选择器 / JS 读取）
  root.dataset.themePreference = settings.appearance.themePreference;
  root.dataset.uiDensity = settings.appearance.uiDensity;
  root.classList.toggle('reduce-motion', settings.appearance.reduceMotion);

  // accent 系列：覆盖主题管理器注入的默认值
  root.style.setProperty('--accent', accentStyle.accent);
  root.style.setProperty('--accent-strong', accentStyle.accentStrong);
  root.style.setProperty('--accent-muted', accentStyle.accentMuted);
  root.style.setProperty('--settings-accent', accentStyle.accent);
  root.style.setProperty('--settings-accent-soft', accentStyle.accentSoft);
  root.style.setProperty('--settings-accent-muted', accentStyle.accentMuted);
  root.style.setProperty('--statusbar-accent', accentStyle.statusbarAccent);

  // 几何与排版参数
  root.style.setProperty('--radius', RADIUS_VALUE_MAP[settings.appearance.radiusPreset]);
  root.style.setProperty('--app-ui-font-size', `${settings.appearance.interfaceFontSize}px`);
  root.style.setProperty(
    '--app-density-scale',
    UI_DENSITY_SCALE_MAP[settings.appearance.uiDensity],
  );
}
