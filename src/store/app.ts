import {
  ACCENT_COLORS,
  RADIUS_PRESETS,
  THEME_MODES,
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
import { computed, ref, watch } from 'vue';

const STORAGE_KEY = 'sh-editor-app-settings';
const LEGACY_THEME_STORAGE_KEY = 'sh-editor-theme';
const DEFAULT_THEME: TThemeMode = 'dark';

const ACCENT_STYLE_MAP: Record<
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
    accent: '#5e6ad2',
    accentStrong: '#6f7cff',
    accentMuted: 'rgba(94, 106, 210, 0.16)',
    accentSoft: 'rgba(94, 106, 210, 0.35)',
    statusbarAccent: '#4c6fff',
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

const RADIUS_VALUE_MAP: Record<TRadiusPreset, string> = {
  sharp: '0.375rem',
  default: '0.625rem',
  rounded: '0.95rem',
};

const UI_DENSITY_SCALE_MAP: Record<TUiDensity, string> = {
  compact: '0.94',
  default: '1',
  comfortable: '1.08',
};

declare global {
  interface Window {
    __SH_APP_SETTINGS_STORAGE_SYNC_CLEANUP__?: (() => void) | undefined;
    __SH_SYSTEM_THEME_SYNC_CLEANUP__?: (() => void) | undefined;
  }
}

const isKnownTheme = (value: unknown): value is TThemeMode =>
  typeof value === 'string' && THEME_MODES.some((theme) => theme === value);

const isKnownThemePreference = (value: unknown): value is TThemePreference =>
  typeof value === 'string' && THEME_PREFERENCES.some((theme) => theme === value);

const isKnownAccentColor = (value: unknown): value is TAccentColor =>
  typeof value === 'string' && ACCENT_COLORS.some((color) => color === value);

const isKnownUiDensity = (value: unknown): value is TUiDensity =>
  typeof value === 'string' && UI_DENSITIES.some((density) => density === value);

const isKnownRadiusPreset = (value: unknown): value is TRadiusPreset =>
  typeof value === 'string' && RADIUS_PRESETS.some((preset) => preset === value);

const hasWindow = (): boolean => typeof window !== 'undefined';
const hasDocument = (): boolean => typeof document !== 'undefined';

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

const readLegacyTheme = (): TThemePreference | null => {
  if (!hasWindow()) return null;

  try {
    const raw = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
    return isKnownTheme(raw) ? raw : null;
  } catch {
    return null;
  }
};

const readStoredSettings = (): IAppSettings => {
  const defaults = createDefaultAppSettings();

  if (!hasWindow()) {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacyTheme = readLegacyTheme();
      if (legacyTheme) {
        defaults.appearance.themePreference = legacyTheme;
      }
      return defaults;
    }

    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaults;
  }
};

const writeStoredSettings = (value: IAppSettings): void => {
  if (!hasWindow()) return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 隐私模式 / 存储配额满 / 被策略禁用时忽略
  }
};

const applyThemeToDocument = (settings: IAppSettings, effectiveTheme: TThemeMode): void => {
  if (!hasDocument()) return;

  const root = document.documentElement;
  if (!root) return;

  const accentStyle = ACCENT_STYLE_MAP[settings.appearance.accentColor];
  root.dataset.theme = effectiveTheme;
  root.dataset.themePreference = settings.appearance.themePreference;
  root.dataset.uiDensity = settings.appearance.uiDensity;
  root.classList.toggle('reduce-motion', settings.appearance.reduceMotion);

  // classList 兼容一些只认 class 的 UI 库（Tailwind dark mode 等）
  root.classList.toggle('dark', effectiveTheme === 'dark');
  root.classList.toggle('light', effectiveTheme === 'light');
  root.style.setProperty('--accent', accentStyle.accent);
  root.style.setProperty('--accent-strong', accentStyle.accentStrong);
  root.style.setProperty('--accent-muted', accentStyle.accentMuted);
  root.style.setProperty('--settings-accent', accentStyle.accent);
  root.style.setProperty('--settings-accent-soft', accentStyle.accentSoft);
  root.style.setProperty('--settings-accent-muted', accentStyle.accentMuted);
  root.style.setProperty('--statusbar-accent', accentStyle.statusbarAccent);
  root.style.setProperty('--radius', RADIUS_VALUE_MAP[settings.appearance.radiusPreset]);
  root.style.setProperty('--app-ui-font-size', `${settings.appearance.interfaceFontSize}px`);
  root.style.setProperty('--app-density-scale', UI_DENSITY_SCALE_MAP[settings.appearance.uiDensity]);
};

const disposeSettingsStorageSync = (): void => {
  if (!hasWindow()) {
    return;
  }

  const cleanup = window.__SH_APP_SETTINGS_STORAGE_SYNC_CLEANUP__;
  if (!cleanup) {
    return;
  }

  cleanup();
  if (window.__SH_APP_SETTINGS_STORAGE_SYNC_CLEANUP__ === cleanup) {
    window.__SH_APP_SETTINGS_STORAGE_SYNC_CLEANUP__ = undefined;
  }
};

const bindSettingsStorageSync = (onSettingsChange: (value: IAppSettings) => void): void => {
  if (!hasWindow()) {
    return;
  }

  disposeSettingsStorageSync();

  const handleStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) {
      return;
    }

    if (!event.newValue) {
      return;
    }

    try {
      onSettingsChange(normalizeSettings(JSON.parse(event.newValue)));
    } catch {
      // ignore malformed storage payload
    }
  };

  window.addEventListener('storage', handleStorage);
  window.__SH_APP_SETTINGS_STORAGE_SYNC_CLEANUP__ = () => {
    window.removeEventListener('storage', handleStorage);
  };
};

const disposeSystemThemeSync = (): void => {
  if (!hasWindow()) {
    return;
  }

  const cleanup = window.__SH_SYSTEM_THEME_SYNC_CLEANUP__;
  if (!cleanup) {
    return;
  }

  cleanup();
  if (window.__SH_SYSTEM_THEME_SYNC_CLEANUP__ === cleanup) {
    window.__SH_SYSTEM_THEME_SYNC_CLEANUP__ = undefined;
  }
};

const bindSystemThemeSync = (onThemeChange: (value: TThemeMode) => void): void => {
  if (!hasWindow() || typeof window.matchMedia !== 'function') {
    return;
  }

  disposeSystemThemeSync();

  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = (event: MediaQueryListEvent): void => {
    onThemeChange(event.matches ? 'dark' : 'light');
  };

  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', handleChange);
    window.__SH_SYSTEM_THEME_SYNC_CLEANUP__ = () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
    return;
  }

  mediaQuery.addListener(handleChange);
  window.__SH_SYSTEM_THEME_SYNC_CLEANUP__ = () => {
    mediaQuery.removeListener(handleChange);
  };
};

export const useAppStore = defineStore('app', () => {
  const settings = ref<IAppSettings>(readStoredSettings());
  const systemTheme = ref<TThemeMode>(resolveSystemTheme());

  settings.value = normalizeSettings(settings.value);

  const themePreference = computed(() => settings.value.appearance.themePreference);
  const theme = computed<TThemeMode>(() =>
    resolveEffectiveTheme(themePreference.value, systemTheme.value),
  );
  const effectiveTheme = computed(() => theme.value);

  const isDark = computed(() => theme.value === 'dark');

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

  watch(
    () => ({
      settings: settings.value,
      effectiveTheme: effectiveTheme.value,
    }),
    ({ settings: nextSettings, effectiveTheme: nextTheme }) => {
      writeStoredSettings(nextSettings);
      applyThemeToDocument(nextSettings, nextTheme);
    },
    { deep: true, immediate: true },
  );

  bindSettingsStorageSync((nextSettings) => {
    settings.value = nextSettings;
  });

  bindSystemThemeSync((nextTheme) => {
    if (nextTheme !== systemTheme.value) {
      systemTheme.value = nextTheme;
    }
  });

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
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeSettingsStorageSync();
    disposeSystemThemeSync();
  });
}
