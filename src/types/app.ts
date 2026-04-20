export type TThemeMode = 'dark' | 'light';

export const THEME_MODES = ['dark', 'light'] as const satisfies ReadonlyArray<TThemeMode>;

export type TThemePreference = TThemeMode | 'system';

export const THEME_PREFERENCES = [
    'dark',
    'light',
    'system',
] as const satisfies ReadonlyArray<TThemePreference>;

export type TAccentColor = 'indigo' | 'violet' | 'blue' | 'teal' | 'gold' | 'red';

export const ACCENT_COLORS = [
    'indigo',
    'violet',
    'blue',
    'teal',
    'gold',
    'red',
] as const satisfies ReadonlyArray<TAccentColor>;

export type TUiDensity = 'compact' | 'default' | 'comfortable';

export const UI_DENSITIES = [
    'compact',
    'default',
    'comfortable',
] as const satisfies ReadonlyArray<TUiDensity>;

export type TRadiusPreset = 'sharp' | 'default' | 'rounded';

export const RADIUS_PRESETS = [
    'sharp',
    'default',
    'rounded',
] as const satisfies ReadonlyArray<TRadiusPreset>;

export type TWorkbenchSidebarView =
    | 'explorer'
    | 'search'
    | 'source-control'
    | 'run'
    | 'extensions';

export const WORKBENCH_SIDEBAR_VIEWS = [
    'explorer',
    'search',
    'source-control',
    'run',
    'extensions',
] as const satisfies ReadonlyArray<TWorkbenchSidebarView>;