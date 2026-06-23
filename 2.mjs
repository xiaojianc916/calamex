#!/usr/bin/env node
/**
 * Calamex 第三轮优化脚本 — round3-optimize.mjs
 *
 * 修改项：
 * 1. file-icons.ts   — 统一使用 lru-cache 散函数，给所有缓存加上限
 * 2. runtime-diagnostics.ts — console.error/console.trace 加 DEV 守卫
 * 3. app.ts           — isPlainObject 改用 Object.getPrototypeOf
 * 4. math.ts          — 新增 clampInt 导出
 * 5. app.ts           — clampNumber 内部改用 clampInt
 * 6. tauri.ipc-runtime.ts — resolveMappedError 按 key 长度降序匹配
 * 7. error-presentation.ts — 提取 stringifyUnknown 为共享模块
 *
 * 用法：
 *   node round3-optimize.mjs --dry-run    # 预览修改，不写文件
 *   node round3-optimize.mjs              # 执行修改
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.env.CALAMEX_ROOT ?? '.';
const DRY_RUN = process.argv.includes('--dry-run');

const log = (msg) => console.log(`[round3] ${msg}`);
const warn = (msg) => console.warn(`[round3] WARN ${msg}`);
const ok = (msg) => console.log(`[round3] OK ${msg}`);

const readFile = (filePath) => {
  const abs = resolve(ROOT, filePath);
  if (!existsSync(abs)) {
    warn(`File not found: ${filePath}`);
    return null;
  }
  return readFileSync(abs, 'utf-8');
};

const writeFile = (filePath, content) => {
  const abs = resolve(ROOT, filePath);
  if (DRY_RUN) {
    log(`[DRY-RUN] would write: ${filePath} (${content.length} bytes)`);
    return;
  }
  writeFileSync(abs, content, 'utf-8');
  ok(`written: ${filePath}`);
};

const replaceExact = (source, oldStr, newStr, filePath) => {
  const idx = source.indexOf(oldStr);
  if (idx === -1) {
    throw new Error(`Anchor not found in ${filePath}:\n${oldStr.slice(0, 100)}...`);
  }
  const second = source.indexOf(oldStr, idx + 1);
  if (second !== -1) {
    throw new Error(`Anchor matches multiple locations in ${filePath}, refusing to replace`);
  }
  return source.slice(0, idx) + newStr + source.slice(idx + oldStr.length);
};

const isAlreadyPatched = (content, marker) => content.includes(marker);

// ── Patch 1: file-icons.ts — unify LRU cache usage ──────────────

const patchFileIcons = () => {
  const filePath = 'src/utils/file/file-icons.ts';
  const content = readFile(filePath);
  if (!content) return;
  if (isAlreadyPatched(content, '// [round3] unified LRU')) {
    log(`${filePath} already patched, skipping`);
    return;
  }

  let p = content;

  // 1a. Add import for lru-cache functions
  p = replaceExact(p,
    "import { fnv1a32Bytes } from '@/utils/core/hash';",
    "import { fnv1a32Bytes } from '@/utils/core/hash';\nimport { getBoundedCacheValue, setBoundedCacheValue } from '@/utils/core/lru-cache'; // [round3] unified LRU",
    filePath
  );

  // 1b. Add ICON_CACHE_LIMIT constant
  p = replaceExact(p,
    'const PIERRE_COLOR_CACHE_LIMIT = 256;',
    'const PIERRE_COLOR_CACHE_LIMIT = 256;\nconst ICON_CACHE_LIMIT = 512; // [round3] unified LRU',
    filePath
  );

  // 1c. Replace PIERRE_COLOR_CACHE while-loop with setBoundedCacheValue
  p = replaceExact(p,
    `  PIERRE_COLOR_CACHE.set(key, asset);
  while (PIERRE_COLOR_CACHE.size > PIERRE_COLOR_CACHE_LIMIT) {
    const oldest = PIERRE_COLOR_CACHE.keys().next().value;
    if (oldest === undefined) break;
    PIERRE_COLOR_CACHE.delete(oldest);
  }`,
    `  setBoundedCacheValue(PIERRE_COLOR_CACHE, key, asset, PIERRE_COLOR_CACHE_LIMIT); // [round3] unified LRU`,
    filePath
  );

  // 1d. Replace PIERRE_COLOR_CACHE get with getBoundedCacheValue
  p = replaceExact(p,
    `  const cached = PIERRE_COLOR_CACHE.get(key);
  if (cached) {
    PIERRE_COLOR_CACHE.delete(key);
    PIERRE_COLOR_CACHE.set(key, cached);
    return cached;
  }`,
    `  const cached = getBoundedCacheValue(PIERRE_COLOR_CACHE, key); // [round3] unified LRU\n  if (cached) {\n    return cached;\n  }`,
    filePath
  );

  // 1e. Replace FILE_ICON_KEY_CACHE get/set with lru-cache
  p = replaceExact(p,
    `  const cached = FILE_ICON_KEY_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const iconKey = resolveFileIconKey(options);
  FILE_ICON_KEY_CACHE.set(cacheKey, iconKey);
  return iconKey;`,
    `  const cached = getBoundedCacheValue(FILE_ICON_KEY_CACHE, cacheKey); // [round3] unified LRU\n  if (cached !== undefined) return cached;\n  const iconKey = resolveFileIconKey(options);\n  setBoundedCacheValue(FILE_ICON_KEY_CACHE, cacheKey, iconKey, ICON_CACHE_LIMIT);\n  return iconKey;`,
    filePath
  );

  // 1f. Replace FILE_ICON_ASSET_CACHE get/set with lru-cache
  p = replaceExact(p,
    `  const cached = FILE_ICON_ASSET_CACHE.get(iconKey);
  if (cached) return cached;
  const asset = resolveThemeIconAssetByKey(iconKey) ?? DEFAULT_FILE_ICON_ASSET;
  FILE_ICON_ASSET_CACHE.set(iconKey, asset);
  return asset;`,
    `  const cached = getBoundedCacheValue(FILE_ICON_ASSET_CACHE, iconKey); // [round3] unified LRU\n  if (cached) return cached;\n  const asset = resolveThemeIconAssetByKey(iconKey) ?? DEFAULT_FILE_ICON_ASSET;\n  setBoundedCacheValue(FILE_ICON_ASSET_CACHE, iconKey, asset, ICON_CACHE_LIMIT);\n  return asset;`,
    filePath
  );

  writeFile(filePath, p);
  ok(`Patch 1 done: ${filePath}`);
};

// ── Patch 2: runtime-diagnostics.ts — DEV guard on console ──────

const patchRuntimeDiagnostics = () => {
  const filePath = 'src/utils/platform/runtime-diagnostics.ts';
  const content = readFile(filePath);
  if (!content) return;
  if (isAlreadyPatched(content, '// [round3] DEV guard')) {
    log(`${filePath} already patched, skipping`);
    return;
  }

  let p = content;

  // Wrap console.error + console.trace in DEV guard
  p = replaceExact(p,
    `  console.error(
    \`[runtime-diagnostics] setRuntimeError 被调用 → 即将置 runtimeErrorState。title=\${title}\`,
    error,
  );
  // eslint-disable-next-line no-console
  console.trace('[runtime-diagnostics] setRuntimeError 调用栈(谁升级了致命错误界面)');`,
    `  // [round3] DEV guard: skip console.trace in production to avoid main-thread pressure
  if (import.meta.env.DEV) {
    console.error(
      \`[runtime-diagnostics] setRuntimeError 被调用 → 即将置 runtimeErrorState。title=\${title}\`,
      error,
    );
    // eslint-disable-next-line no-console
    console.trace('[runtime-diagnostics] setRuntimeError 调用栈(谁升级了致命错误界面)');
  }`,
    filePath
  );

  writeFile(filePath, p);
  ok(`Patch 2 done: ${filePath}`);
};

// ── Patch 3: app.ts — isPlainObject prototype check ─────────────

const patchAppStore = () => {
  const filePath = 'src/store/app.ts';
  const content = readFile(filePath);
  if (!content) return;
  if (isAlreadyPatched(content, '// [round3] prototype check')) {
    log(`${filePath} already patched, skipping`);
    return;
  }

  let p = content;

  p = replaceExact(p,
    `const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === '[object Object]';`,
    `// [round3] prototype check: more precise than toString.call, excludes class instances
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};`,
    filePath
  );

  writeFile(filePath, p);
  ok(`Patch 3 done: ${filePath}`);
};

// ── Patch 4+5: math.ts clampInt + app.ts clampNumber ────────────

const patchMathAndApp = () => {
  // 4. Add clampInt to math.ts
  const mathPath = 'src/utils/core/math.ts';
  const mathContent = readFile(mathPath);
  if (mathContent) {
    if (isAlreadyPatched(mathContent, '// [round3] clampInt')) {
      log(`${mathPath} already patched, skipping`);
    } else {
      let mp = mathContent;
      mp = replaceExact(mp,
        `export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));`,
        `export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** clamp + Math.round, for settings that require integers. */ // [round3] clampInt
export const clampInt = (value: number, min: number, max: number): number =>
  Math.round(clamp(value, min, max));`,
        mathPath
      );
      writeFile(mathPath, mp);
      ok(`Patch 4 done: ${mathPath}`);
    }
  }

  // 5. Replace clampNumber in app.ts to use clampInt
  const appPath = 'src/store/app.ts';
  const appContent = readFile(appPath);
  if (appContent) {
    if (isAlreadyPatched(appContent, '// [round3] clampInt')) {
      log(`${appPath} already patched (clampInt), skipping`);
    } else {
      let ap = appContent;

      // Add import
      ap = replaceExact(ap,
        `import {
  createDefaultAppSettings,
  type IAppSettings,
  type TAppSettingsSectionKey,
} from '@/types/settings';`,
        `import {
  createDefaultAppSettings,
  type IAppSettings,
  type TAppSettingsSectionKey,
} from '@/types/settings';
import { clampInt } from '@/utils/core/math'; // [round3] clampInt`,
        appPath
      );

      // Replace clampNumber internal clamp function
      ap = replaceExact(ap,
        `const clampNumber = (value: unknown, [min, max]: TNumberRange, fallback?: number): number => {
  const clamp = (n: number): number => Math.min(max, Math.max(min, Math.round(n)));
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return clamp(fallback);
  }
  return min;
};`,
        `const clampNumber = (value: unknown, [min, max]: TNumberRange, fallback?: number): number => {
  // [round3] clampInt: reuse math.ts unified implementation
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clampInt(value, min, max);
  }
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return clampInt(fallback, min, max);
  }
  return min;
};`,
        appPath
      );

      writeFile(appPath, ap);
      ok(`Patch 5 done: ${appPath}`);
    }
  }
};

// ── Patch 6: tauri.ipc-runtime.ts — errorMap sort by key length ──

const patchIpcRuntime = () => {
  const filePath = 'src/services/tauri.ipc-runtime.ts';
  const content = readFile(filePath);
  if (!content) return;
  if (isAlreadyPatched(content, '// [round3] long key first')) {
    log(`${filePath} already patched, skipping`);
    return;
  }

  let p = content;

  p = replaceExact(p,
    `const resolveMappedError = (message: string, errorMap: TErrorMap): IIpcErrorMapping | null => {
  for (const [needle, mapped] of Object.entries(errorMap)) {
    if (message.includes(needle)) {
      return mapped;
    }
  }

  return null;
};`,
    `// [round3] long key first: sort by key length descending to avoid short keys shadowing more specific ones
const resolveMappedError = (message: string, errorMap: TErrorMap): IIpcErrorMapping | null => {
  const entries = Object.entries(errorMap).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [needle, mapped] of entries) {
    if (message.includes(needle)) {
      return mapped;
    }
  }

  return null;
};`,
    filePath
  );

  writeFile(filePath, p);
  ok(`Patch 6 done: ${filePath}`);
};

// ── Patch 7: error-presentation.ts — extract stringifyUnknown ──

const patchErrorPresentation = () => {
  const filePath = 'src/utils/error/error-presentation.ts';
  const content = readFile(filePath);
  if (!content) return;

  // First check if stringify.ts already exists
  const stringifyPath = 'src/utils/error/stringify.ts';
  const existingStringify = readFile(stringifyPath);
  if (existingStringify) {
    log(`${stringifyPath} already exists, skipping creation`);
    return;
  }
  if (isAlreadyPatched(content, '// [round3] stringify')) {
    log(`${filePath} already patched, skipping`);
    return;
  }

  // Create stringify.ts
  writeFile(stringifyPath,
    `/**
 * Serialize any value to string for error display.
 * [round3] stringify: extracted from error-presentation.ts and runtime-diagnostics.ts.
 */
export const stringifyErrorDetail = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
`
  );
  ok(`Patch 7a done: created ${stringifyPath}`);

  // Modify error-presentation.ts to import from stringify.ts
  let p = content;

  // Add import
  p = replaceExact(p,
    `import { toErrorMessage } from '@/utils/error/error';`,
    `import { toErrorMessage } from '@/utils/error/error';
import { stringifyErrorDetail } from '@/utils/error/stringify'; // [round3] stringify`,
    filePath
  );

  // Replace stringifyUnknown function body
  p = replaceExact(p,
    `const stringifyUnknown = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (value instanceof Error) {
    return value.stack ?? value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};`,
    `// [round3] stringify: reuse shared module
const stringifyUnknown = stringifyErrorDetail;`,
    filePath
  );

  writeFile(filePath, p);
  ok(`Patch 7b done: ${filePath}`);
};

// ── Main ────────────────────────────────────────────────────────

const main = () => {
  log(`Calamex round-3 optimization ${DRY_RUN ? '(DRY-RUN)' : ''}`);
  log(`Root: ${resolve(ROOT)}`);
  log('');

  const patches = [
    ['file-icons.ts LRU unification',     patchFileIcons],
    ['runtime-diagnostics.ts DEV guard',   patchRuntimeDiagnostics],
    ['app.ts isPlainObject prototype',      patchAppStore],
    ['math.ts + app.ts clampInt',           patchMathAndApp],
    ['tauri.ipc-runtime.ts sort errorMap',  patchIpcRuntime],
    ['error-presentation.ts stringify',     patchErrorPresentation],
  ];

  let success = 0;
  let failed = 0;

  for (const [name, fn] of patches) {
    try {
      log(`Running: ${name}`);
      fn();
      success++;
    } catch (error) {
      warn(`${name} FAILED: ${error.message}`);
      failed++;
    }
    log('');
  }

  log('────────────────────────────────');
  log(`Success: ${success}  Failed: ${failed}`);
  if (failed > 0) {
    warn('Some patches failed, check logs above');
    process.exit(1);
  }
  ok('All done!');
};

main();