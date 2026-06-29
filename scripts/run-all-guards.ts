/**
 * run-all-guards.ts
 * 聚合运行所有静态守卫脚本，统一汇报结果。
 * 用法：tsx scripts/run-all-guards.ts
 */
import { ExecSyncOptionsWithStringEncoding, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

// 优先使用本地安装的 tsx，兼容未在 PATH 中配置的环境
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', 'tsx.CMD');

const GUARDS = [
  'check-file-size.ts',
  'check-workbench-facade.ts',
  'check-router-disabled.ts',
  'check-terminal-singleton.ts',
  'check-capabilities-domain.ts',
  'check-config-refs.ts',
  'check-dormant-modules.ts',
  'check-versions.ts',
];

let anyError = false;
const opts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf-8', stdio: 'inherit' };

console.log('\n\x1b[1m=== 守卫脚本聚合运行 ===\x1b[0m\n');

for (const guard of GUARDS) {
  const guardPath = path.join(__dirname, guard);
  console.log(`\x1b[36m--- ${guard} ---\x1b[0m`);
  try {
    execSync(`"${TSX_BIN}" "${guardPath}"`, opts);
  } catch {
    anyError = true;
  }
  console.log('');
}

if (anyError) {
  console.log('\x1b[31m✗ 守卫检查存在 ERROR，请修复后重试\x1b[0m');
  process.exit(1);
} else {
  console.log('\x1b[32m✓ 所有守卫检查通过\x1b[0m');
  process.exit(0);
}
