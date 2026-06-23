#!/usr/bin/env node
// @ts-check
/**
 * round3-typed-ipc-error.mjs
 *
 * 目的：把「桌面运行时缺失」错误从「按本地化中文文案 substring 匹配」
 *       改造为「按类型(DesktopRuntimeUnavailableError) + 稳定 code 判别」。
 *
 * 行为等价（不影响用户体验）：文案不变、code 仍为 'ipc.desktop-only'、
 *   scope 仍为 'ipc'；仅把分类依据从字符串包含改为错误类型，并补回真实 traceId。
 *
 * 特性：默认 dry-run；--apply 才写盘；幂等（已改过自动跳过）；
 *       严格锚点匹配（锚点缺失或重复出现即报错中止，绝不模糊改写）。
 *
 * 用法：
 *   node round3-typed-ipc-error.mjs                # 预览(dry-run)
 *   node round3-typed-ipc-error.mjs --apply        # 实际写入
 *   node round3-typed-ipc-error.mjs --root <repo>  # 指定仓库根(默认 cwd)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const rootIdx = argv.indexOf('--root');
const ROOT =
  rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1]) : process.cwd();

const join = (...lines) => lines.join('\n');

// ---- 文件 1: src/utils/platform/desktop-runtime.ts ----
const RUNTIME_FILE = 'src/utils/platform/desktop-runtime.ts';

const RUNTIME_CLASS_BLOCK = join(
  '/**',
  ' * 桌面运行时缺失（浏览器预览模式）的类型化错误。',
  ' * 携带稳定、机器可读的 code，供 IPC 归一层按「类型」判别，',
  ' * 而非匹配本地化文案（文案一旦改写/国际化即让分类静默失效）。',
  ' */',
  'export class DesktopRuntimeUnavailableError extends Error {',
  "  readonly code = 'ipc.desktop-only';",
  '  constructor(scene: string) {',
  '    super(',
  '      `当前为浏览器预览模式，${scene}仅支持 Tauri 桌面端。请执行 npm run tauri:dev 后重试。`,',
  '    );',
  "    this.name = 'DesktopRuntimeUnavailableError';",
  '  }',
  '}',
);

const RUNTIME_FN_ANCHOR =
  'export const assertDesktopRuntime = async (scene: string): Promise<void> => {';

// 用正则匹配 throw，容忍本地 biome/prettier 把它格式化成单行或多行
const RUNTIME_THROW_REGEX =
  /throw new Error\(\s*`当前为浏览器预览模式，\$\{scene\}仅支持 Tauri 桌面端。请执行 npm run tauri:dev 后重试。`,?\s*\);/;
const RUNTIME_THROW_REPLACEMENT = 'throw new DesktopRuntimeUnavailableError(scene);';

// ---- 文件 2: src/services/tauri.ipc-runtime.ts ----
const IPC_FILE = 'src/services/tauri.ipc-runtime.ts';

const IPC_IMPORT_ANCHOR =
  "import { assertDesktopRuntime } from '@/utils/platform/desktop-runtime';";
const IPC_IMPORT_REPLACEMENT = join(
  'import {',
  '  assertDesktopRuntime,',
  '  DesktopRuntimeUnavailableError,',
  "} from '@/utils/platform/desktop-runtime';",
);

const IPC_BRANCH_ANCHOR = join(
  "  const baseMessage = toErrorMessage(error, 'IPC 调用失败');",
  '',
  "  if (baseMessage.includes('浏览器预览模式')) {",
  '    return new AppError({',
  "      code: 'ipc.desktop-only',",
  '      message: baseMessage,',
  "      scope: 'ipc',",
  '      traceId: context.traceId,',
  '      cause: error,',
  '    });',
  '  }',
  '',
  '  const mapped = resolveMappedError(baseMessage, context.errorMap);',
);
const IPC_BRANCH_REPLACEMENT = join(
  '  if (error instanceof DesktopRuntimeUnavailableError) {',
  '    return new AppError({',
  '      code: error.code,',
  '      message: error.message,',
  "      scope: 'ipc',",
  '      traceId: context.traceId,',
  '      cause: error,',
  '    });',
  '  }',
  '',
  "  const baseMessage = toErrorMessage(error, 'IPC 调用失败');",
  '',
  '  const mapped = resolveMappedError(baseMessage, context.errorMap);',
);

const PLAN = [
  {
    file: RUNTIME_FILE,
    ops: [
      {
        name: '注入 DesktopRuntimeUnavailableError 类',
        kind: 'insertBefore',
        find: RUNTIME_FN_ANCHOR,
        replace: RUNTIME_CLASS_BLOCK,
        done: 'class DesktopRuntimeUnavailableError',
      },
      {
        name: '改为抛出类型化错误',
        kind: 'replace',
        find: RUNTIME_THROW_REGEX,
        replace: RUNTIME_THROW_REPLACEMENT,
        done: 'throw new DesktopRuntimeUnavailableError(scene);',
      },
    ],
  },
  {
    file: IPC_FILE,
    ops: [
      {
        name: '导入类型化错误',
        kind: 'replace',
        find: IPC_IMPORT_ANCHOR,
        replace: IPC_IMPORT_REPLACEMENT,
        done: 'DesktopRuntimeUnavailableError,',
      },
      {
        name: '按类型判别替换 substring 分支',
        kind: 'replace',
        find: IPC_BRANCH_ANCHOR,
        replace: IPC_BRANCH_REPLACEMENT,
        done: 'if (error instanceof DesktopRuntimeUnavailableError) {',
      },
    ],
  },
];

const occurrences = (haystack, needle) => {
  if (needle instanceof RegExp) {
    const flags = needle.flags.includes('g') ? needle.flags : `${needle.flags}g`;
    const m = haystack.match(new RegExp(needle.source, flags));
    return m ? m.length : 0;
  }
  return haystack.split(needle).length - 1;
};

let changedFiles = 0;
let failures = 0;

for (const { file, ops } of PLAN) {
  const abs = path.join(ROOT, file);
  if (!existsSync(abs)) {
    console.error(`✗ 缺少文件：${file}`);
    failures++;
    continue;
  }
  const original = await readFile(abs, 'utf8');
  let content = original;
  const log = [];

  for (const op of ops) {
    if (content.includes(op.done)) {
      log.push(`  • [skip] ${op.name}（已应用）`);
      continue;
    }
    const n = occurrences(content, op.find);
    if (n === 0) {
      log.push(`  ✗ [fail] ${op.name}：锚点未找到`);
      failures++;
      continue;
    }
    if (n > 1) {
      log.push(`  ✗ [fail] ${op.name}：锚点出现 ${n} 次，拒绝模糊改写`);
      failures++;
      continue;
    }
    const replacement =
      op.kind === 'insertBefore' ? `${op.replace}\n\n${op.find}` : op.replace;
    content = content.replace(op.find, replacement);
    log.push(`  ✓ [edit] ${op.name}`);
  }

  console.log(`\n${file}`);
  for (const line of log) console.log(line);

  if (content !== original) {
    changedFiles++;
    if (APPLY) {
      await writeFile(abs, content, 'utf8');
      console.log('  → 已写入');
    } else {
      console.log('  → dry-run（未写入，加 --apply 生效）');
    }
  }
}

console.log(
  `\n汇总：拟修改 ${changedFiles} 个文件，失败 ${failures} 项。${APPLY ? '' : '（dry-run）'}`,
);

if (failures > 0) process.exitCode = 1;