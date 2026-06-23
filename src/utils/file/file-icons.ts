import pierreIconTheme from '@/assets/icons/pierre/theme-complete.json';
import type {
  IFileIconAsset,
  IFileIconResolveOptions,
  IPierreFileIconTheme,
} from '@/types/file-icon';
import { fnv1a32Bytes } from '@/utils/core/hash';
import { getBoundedCacheValue, setBoundedCacheValue } from '@/utils/core/lru-cache'; // [round3] unified LRU
import { getPathBaseName } from '@/utils/file/path';

const PIERRE_ICON_THEME = pierreIconTheme as IPierreFileIconTheme;
const PIERRE_MONOCHROME_DARK_FILL = '#adadb1';
const PIERRE_MONOCHROME_LIGHT_FILL = '#6c6c71';
const PIERRE_COLOR_CACHE_LIMIT = 256;
const ICON_CACHE_LIMIT = 512; // [round3] unified LRU
const PIERRE_COLOR_CACHE = new Map<string, IFileIconAsset>();

const FILE_ICON_ASSET_MODULES = import.meta.glob('../../assets/icons/pierre/*.svg', {
  eager: true,
  import: 'default',
}) as Record<string, string>;
const FILE_ICON_RAW_MODULES = import.meta.glob('../../assets/icons/pierre/*.svg', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

const FILE_NAME_ICON_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'cargo.lock': 'lang-rust',
  'cargo.toml': 'lang-rust',
});
const PIERRE_PALETTE = Object.freeze({
  red: { dark: '#ff6762', light: '#d52c36' },
  vermilion: { dark: '#ff8c5b', light: '#d5512f' },
  orange: { dark: '#ffa359', light: '#d47628' },
  yellow: { dark: '#ffd452', light: '#d5a910' },
  green: { dark: '#5ecc71', light: '#199f43' },
  mint: { dark: '#61d5c0', light: '#16a994' },
  teal: { dark: '#64d1db', light: '#17a5af' },
  cyan: { dark: '#68cdf2', light: '#1ca1c7' },
  blue: { dark: '#69b1ff', light: '#1a85d4' },
  indigo: { dark: '#9d6afb', light: '#693acf' },
  purple: { dark: '#d568ea', light: '#a631be' },
  pink: { dark: '#ff678d', light: '#d32a61' },
  brown: { dark: '#c3987b', light: '#956b4f' },
});

type TPierrePaletteHue = keyof typeof PIERRE_PALETTE;

const MONOCHROME_ICON_COLOR_POOLS: Readonly<Record<string, readonly TPierrePaletteHue[]>> =
  Object.freeze({
    'bash-duo': ['green', 'mint', 'teal'],
    braces: ['yellow', 'orange', 'indigo'],
    'file-duo': ['blue', 'cyan', 'indigo', 'purple', 'teal'],
    'file-symlink-duo': ['blue', 'cyan', 'teal'],
    'file-table-duo': ['green', 'mint', 'teal', 'cyan'],
    'file-text-duo': ['green', 'mint', 'teal', 'cyan'],
    'file-zip-duo': ['yellow', 'orange', 'brown', 'vermilion'],
    'folder-duo': ['yellow', 'orange', 'brown'],
    'folder-open-duo': ['yellow', 'orange', 'brown'],
    font: ['purple', 'pink', 'indigo'],
    'image-duo': ['orange', 'pink', 'purple', 'blue'],
    'lang-markdown': ['teal', 'mint', 'cyan'],
    nextjs: ['indigo', 'purple', 'blue'],
    'server-duo': ['cyan', 'blue', 'indigo'],
    stylelint: ['mint', 'teal', 'green'],
  });

const MONOCHROME_ICON_COLOR_SEED_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'folder-open-duo': 'folder-duo',
});

// ── 预编译正则（热路径不再每次 new RegExp）────────────────────
const DARK_FILL_PATTERN = new RegExp(PIERRE_MONOCHROME_DARK_FILL, 'gi');
const LIGHT_FILL_PATTERN = new RegExp(PIERRE_MONOCHROME_LIGHT_FILL, 'gi');

// ── 主题映射预处理 ─────────────────────────────────────────────
const normalizeThemeMap = (value: Record<string, string> | undefined): Record<string, string> => {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, iconKey]) => [key.toLowerCase(), iconKey]),
  );
};

const FILE_NAME_ICON_MAP: Readonly<Record<string, string>> = Object.freeze({
  ...normalizeThemeMap(PIERRE_ICON_THEME.fileNames),
  ...FILE_NAME_ICON_OVERRIDES,
});

const FILE_EXTENSION_ICON_MAP: Readonly<Record<string, string>> = Object.freeze(
  normalizeThemeMap(PIERRE_ICON_THEME.fileExtensions),
);

const hasThemeIconDefinition = (key: string): boolean =>
  Object.hasOwn(PIERRE_ICON_THEME.iconDefinitions, key);

// ── 路径/文件名工具 ───────────────────────────────────────────
const getFileName = (path: string | null | undefined): string =>
  path ? getPathBaseName(path).toLowerCase() : '';

const getExtensionCandidates = (fileName: string): string[] => {
  const segments = fileName.split('.');
  if (segments.length <= 1) return [];
  const candidates: string[] = [];
  for (let i = 1; i < segments.length; i++) candidates.push(segments.slice(i).join('.'));
  return candidates;
};

// ── 图标 key 解析 ──────────────────────────────────────────────
const resolveMappedKey = (value: string | undefined): string | null =>
  value && hasThemeIconDefinition(value) ? value : null;

const resolveNamedFileIconKey = (fileName: string): string | null => {
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'file-text-duo';
  if (fileName === 'readme' || fileName.startsWith('readme.')) return 'lang-markdown';
  if (
    fileName === 'license' ||
    fileName.startsWith('license.') ||
    fileName === 'licence' ||
    fileName.startsWith('licence.')
  )
    return 'file-text-duo';
  return resolveMappedKey(FILE_NAME_ICON_MAP[fileName]);
};

const resolveFileIconKey = ({ kind, path, expanded = false }: IFileIconResolveOptions): string => {
  if (kind === 'directory')
    return expanded ? PIERRE_ICON_THEME.folderExpanded : PIERRE_ICON_THEME.folder;
  const fileName = getFileName(path);
  if (!fileName) return PIERRE_ICON_THEME.file;
  const namedKey = resolveNamedFileIconKey(fileName);
  if (namedKey) return namedKey;
  for (const candidate of getExtensionCandidates(fileName)) {
    const mapped = resolveMappedKey(FILE_EXTENSION_ICON_MAP[candidate]);
    if (mapped) return mapped;
  }
  return PIERRE_ICON_THEME.file;
};

// ── 资源解析 ───────────────────────────────────────────────────
const resolveAssetModuleKey = (iconPath: string): string =>
  `../../assets/icons/pierre/${iconPath.replace(/^\.\//, '')}`;

const encodeSvgDataUri = (svg: string): string =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;

const applyPierreFallbackColor = (svg: string, fillColor: string, pattern: RegExp): string =>
  svg.replace(pattern, fillColor);

// ── FNV-1a 哈希取模辅助 ───────────────────────────────────────
// fnv1a32Bytes 返回 8 位 hex，这里需要 base36 索引。
const fnv1a32Base36Index = (value: string, modulus: number): number => {
  const hex = fnv1a32Bytes(value);
  // 取后 7 位 hex(28 bit) 转 number，避免 32 位溢出
  return Number.parseInt(hex.slice(-7), 16) % modulus;
};

const resolveColorizedFallbackIconAsset = (key: string): IFileIconAsset | null => {
  const palettePool = MONOCHROME_ICON_COLOR_POOLS[key];
  const darkDefinition = PIERRE_ICON_THEME.iconDefinitions[key];
  if (!palettePool || !darkDefinition) return null;

  // LRU 缓存：命中即返回。超限时淘汰最旧条目。
  const cached = getBoundedCacheValue(PIERRE_COLOR_CACHE, key); // [round3] unified LRU
  if (cached) {
    return cached;
  }

  const lightDefinition = PIERRE_ICON_THEME.iconDefinitions[`${key}_light`] ?? darkDefinition;
  const darkRaw = FILE_ICON_RAW_MODULES[resolveAssetModuleKey(darkDefinition.iconPath)] ?? null;
  const lightRaw =
    FILE_ICON_RAW_MODULES[resolveAssetModuleKey(lightDefinition.iconPath)] ?? darkRaw;
  if (!darkRaw || !lightRaw) return null;

  const paletteSeed = MONOCHROME_ICON_COLOR_SEED_OVERRIDES[key] ?? key;
  const paletteHue = palettePool[fnv1a32Base36Index(paletteSeed, palettePool.length)];
  const colors = PIERRE_PALETTE[paletteHue];

  const asset: IFileIconAsset = {
    darkSrc: encodeSvgDataUri(applyPierreFallbackColor(darkRaw, colors.dark, DARK_FILL_PATTERN)),
    lightSrc: encodeSvgDataUri(
      applyPierreFallbackColor(lightRaw, colors.light, LIGHT_FILL_PATTERN),
    ),
  };

  setBoundedCacheValue(PIERRE_COLOR_CACHE, key, asset, PIERRE_COLOR_CACHE_LIMIT); // [round3] unified LRU

  return asset;
};

const resolveThemeIconAssetByKey = (key: string): IFileIconAsset | null => {
  const colorized = resolveColorizedFallbackIconAsset(key);
  if (colorized) return colorized;

  const darkDefinition = PIERRE_ICON_THEME.iconDefinitions[key];
  if (!darkDefinition) return null;
  const lightDefinition = PIERRE_ICON_THEME.iconDefinitions[`${key}_light`] ?? darkDefinition;
  const darkSrc = FILE_ICON_ASSET_MODULES[resolveAssetModuleKey(darkDefinition.iconPath)] ?? null;
  const lightSrc =
    FILE_ICON_ASSET_MODULES[resolveAssetModuleKey(lightDefinition.iconPath)] ?? darkSrc;
  const fallback = darkSrc ?? lightSrc;
  if (!fallback) return null;
  return { darkSrc: darkSrc ?? fallback, lightSrc: lightSrc ?? fallback };
};

const resolveRequiredThemeIconAsset = (key: string): IFileIconAsset => {
  const asset = resolveThemeIconAssetByKey(key);
  if (!asset) throw new Error(`Pierre Icons 资源缺失：${key}`);
  return asset;
};

const DEFAULT_FILE_ICON_ASSET = resolveRequiredThemeIconAsset(PIERRE_ICON_THEME.file);

// ── 记忆化缓存 ─────────────────────────────────────────────────
const FILE_ICON_KEY_CACHE = new Map<string, string>();
const FILE_ICON_ASSET_CACHE = new Map<string, IFileIconAsset>();

const resolveFileIconKeyMemoized = (options: IFileIconResolveOptions): string => {
  const cacheKey = `${options.kind}\u0000${options.expanded ? '1' : '0'}\u0000${options.path ?? ''}`;
  const cached = getBoundedCacheValue(FILE_ICON_KEY_CACHE, cacheKey); // [round3] unified LRU
  if (cached !== undefined) return cached;
  const iconKey = resolveFileIconKey(options);
  setBoundedCacheValue(FILE_ICON_KEY_CACHE, cacheKey, iconKey, ICON_CACHE_LIMIT);
  return iconKey;
};

const resolveFileIconAssetByKey = (iconKey: string): IFileIconAsset => {
  const cached = getBoundedCacheValue(FILE_ICON_ASSET_CACHE, iconKey); // [round3] unified LRU
  if (cached) return cached;
  const asset = resolveThemeIconAssetByKey(iconKey) ?? DEFAULT_FILE_ICON_ASSET;
  setBoundedCacheValue(FILE_ICON_ASSET_CACHE, iconKey, asset, ICON_CACHE_LIMIT);
  return asset;
};

export const resolveFileIconAsset = (options: IFileIconResolveOptions): IFileIconAsset =>
  resolveFileIconAssetByKey(resolveFileIconKeyMemoized(options));
