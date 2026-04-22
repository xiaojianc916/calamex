import { applyResolvedThemeEffect } from '@/themes/effects';
import {
  ACCENT_COLORS,
  RADIUS_PRESETS,
  THEME_PREFERENCES,
  UI_DENSITIES,
  type TAccentColor,
  type TRadiusPreset,
  type TThemeMode,
  type TThemePreference,
  type TUiDensity,
} from '@/types/app';
import {
  createDefaultAppSettings,
  type IAppSettings,
  type TAppSettingsSectionKey,
} from '@/types/settings';
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, watch } from 'vue';
import { APP_STORE_KEY } from './index';

const DEFAULT_THEME: TThemeMode = 'dark';

const isKnownThemePreference = (value: unknown): value is TThemePreference =>
  typeof value === 'string' && THEME_PREFERENCES.some((theme) => theme === value);

const isKnownAccentColor = (value: unknown): value is TAccentColor =>
  typeof value === 'string' && ACCENT_COLORS.some((color) => color === value);

const isKnownUiDensity = (value: unknown): value is TUiDensity =>
  typeof value === 'string' && UI_DENSITIES.some((density) => density === value);

const isKnownRadiusPreset = (value: unknown): value is TRadiusPreset =>
  typeof value === 'string' && RADIUS_PRESETS.some((preset) => preset === value);

const hasWindow = (): boolean => typeof window !== 'undefined';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]';

const mergeSettingsValue = <T>(defaults: T, value: unknown): T => {
  if (Array.isArray(defaults)) {
    return (Array.isArray(value) ? value : defaults) as T;
  }

  if (isPlainObject(defaults)) {
    if (!isPlainObject(value)) {
      return defaults;
    }

    const nextValue = { ...defaults } as Record<string, unknown>;

    Object.keys(defaults).forEach((key) => {
      nextValue[key] = mergeSettingsValue(
        (defaults as Record<string, unknown>)[key],
        value[key],
      );
    });

    return nextValue as T;
  }

  if (typeof defaults === 'number') {
    return (typeof value === 'number' && Number.isFinite(value) ? value : defaults) as T;
  }

  if (typeof defaults === 'boolean') {
    return (typeof value === 'boolean' ? value : defaults) as T;
  }

  if (typeof defaults === 'string') {
    return (typeof value === 'string' ? value : defaults) as T;
  }

  return defaults;
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

const resolveSystemTheme = (): TThemeMode => {
  if (!hasWindow() || typeof window.matchMedia !== 'function') {
    return DEFAULT_THEME;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const resolveEffectiveTheme = (
  themePreference: TThemePreference,
  systemTheme: TThemeMode,
): TThemeMode => (themePreference === 'system' ? systemTheme : themePreference);

const normalizeSettings = (value: unknown): IAppSettings => {
  const defaults = createDefaultAppSettings();
  const merged = mergeSettingsValue(defaults, value);

  merged.appearance.themePreference = isKnownThemePreference(merged.appearance.themePreference)
    ? merged.appearance.themePreference
    : defaults.appearance.themePreference;
  merged.appearance.accentColor = isKnownAccentColor(merged.appearance.accentColor)
    ? merged.appearance.accentColor
    : defaults.appearance.accentColor;
  merged.appearance.uiDensity = isKnownUiDensity(merged.appearance.uiDensity)
    ? merged.appearance.uiDensity
    : defaults.appearance.uiDensity;
  merged.appearance.radiusPreset = isKnownRadiusPreset(merged.appearance.radiusPreset)
    ? merged.appearance.radiusPreset
    : defaults.appearance.radiusPreset;
  merged.appearance.interfaceFontSize = clampNumber(
    merged.appearance.interfaceFontSize,
    12,
    16,
  );
  merged.general.recentFileLimit = clampNumber(merged.general.recentFileLimit, 5, 100);
  merged.editor.fontSize = clampNumber(merged.editor.fontSize, 11, 20);
  merged.editor.tabSize = clampNumber(merged.editor.tabSize, 2, 8);
  merged.editor.suggestionDelay = clampNumber(merged.editor.suggestionDelay, 0, 2000);
  merged.terminal.fontSize = clampNumber(merged.terminal.fontSize, 11, 20);
  merged.terminal.scrollback = clampNumber(merged.terminal.scrollback, 1000, 20000);
  merged.run.stopTimeoutSeconds = clampNumber(merged.run.stopTimeoutSeconds, 1, 30);
  merged.run.preservedTerminalCount = clampNumber(merged.run.preservedTerminalCount, 1, 20);
  merged.style.shfmtIndentSize = clampNumber(merged.style.shfmtIndentSize, 2, 8);
  merged.style.rulerColumn = clampNumber(merged.style.rulerColumn, 60, 240);
  merged.integrations.sshConnectTimeoutSeconds = clampNumber(
    merged.integrations.sshConnectTimeoutSeconds,
    3,
    60,
  );

  merged.editor.completionTriggers = merged.editor.completionTriggers
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
  merged.style.ignoredRules = merged.style.ignoredRules
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 16);
  merged.run.environmentVariables = merged.run.environmentVariables
    .filter((item) => Boolean(item.id))
    .slice(0, 20);

  return merged;
};

export const useAppStore = defineStore(
  'app',
  () => {
    // 初始值：由 pinia-plugin-persistedstate 在 hydrate 阶段从 localStorage 恢复；
    // 此处使用默认值，afterHydrate 钩子会完成 normalize。
    const settings = ref<IAppSettings>(createDefaultAppSettings());
    const systemTheme = ref<TThemeMode>(resolveSystemTheme());

    const themePreference = computed(() => settings.value.appearance.themePreference);
    const theme = computed<TThemeMode>(() =>
      resolveEffectiveTheme(themePreference.value, systemTheme.value),
    );
    const effectiveTheme = computed(() => theme.value);

    const isDark = computed(() => theme.value === 'dark');

    // ── 系统主题监听（媒体查询，非 localStorage）──────────────────────────────
    if (hasWindow() && typeof window.matchMedia === 'function') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (event: MediaQueryListEvent): void => {
        const next: TThemeMode = event.matches ? 'dark' : 'light';
        if (next !== systemTheme.value) {
          systemTheme.value = next;
        }
      };

      if (typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', handleChange);
        onScopeDispose(() => {
          mediaQuery.removeEventListener('change', handleChange);
        });
      }
    }

    // ── DOM 副作用：主题变化时刷新 CSS 变量（写入由 effects.ts 完成）──────────
    watch(
      () => ({
        settings: settings.value,
        effectiveTheme: effectiveTheme.value,
      }),
      ({ settings: nextSettings, effectiveTheme: nextTheme }) => {
        applyResolvedThemeEffect(nextSettings, nextTheme);
      },
      { deep: true, immediate: true },
    );

    const applyTheme = (value: TThemePreference): void => {
      if (!isKnownThemePreference(value)) {
        return;
      }

      settings.value.appearance.themePreference = value;
    };

    const toggleTheme = (): void => {
      applyTheme(isDark.value ? 'light' : 'dark');
    };

    const replaceSettings = (nextSettings: IAppSettings): void => {
      settings.value = normalizeSettings(nextSettings);
    };

    const resetSettingsSection = (section: TAppSettingsSectionKey): void => {
      settings.value[section] = createDefaultAppSettings()[section];
    };

    return {
      settings,
      systemTheme,
      themePreference,
      theme,
      effectiveTheme,
      isDark,
      applyTheme,
      toggleTheme,
      replaceSettings,
      resetSettingsSection,
    };
  },
  {
    persist: {
      key: APP_STORE_KEY,
      // 只持久化用户设置，排除派生状态（systemTheme 来自系统，不需持久化）
      pick: ['settings'],
      // hydrate 完成后 normalize 确保存储数据合法
      afterHydrate(ctx) {
        // ctx.store.settings 是 pinia setup store 中返回的 ref 的值
        const store = ctx.store as { settings: IAppSettings };
        store.settings = normalizeSettings(store.settings);
      },
    },
  },
);
