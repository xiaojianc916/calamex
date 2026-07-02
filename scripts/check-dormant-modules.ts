/**
 * check-dormant-modules.ts
 * 扫描已标注为 dormant 的模块目录（R-18.2.2 / R-20.8.2）：
 * 1. 目录内 index.ts / index.js 顶部必须有 `@status: dormant` 注释
 * 2. 目录内必须有 README.md
 * 3. dormant 模块 MUST NOT 被业务代码 import（仅检查重要路径）
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CheckResult,
  checkExemption,
  loadBaseline,
  printResult,
  ROOT,
  summarize,
} from './guard-utils.js';

const exemptions = loadBaseline('dormant-modules');
const results: CheckResult[] = [];

const MODULE_DIRS = [{ dir: 'src/router', mainFile: 'index.ts' }];

for (const { dir, mainFile } of MODULE_DIRS) {
  const absDir = path.join(ROOT, dir);
  const readmePath = path.join(absDir, 'README.md');
  const mainPath = path.join(absDir, mainFile);
  const relDir = dir;

  if (!fs.existsSync(mainPath)) {
    results.push({
      severity: 'WARN',
      message: `模块主文件不存在，跳过状态检查`,
      file: `${relDir}/${mainFile}`,
    });
    continue;
  }

  const content = fs.readFileSync(mainPath, 'utf-8');
  const firstLines = content.split('\n').slice(0, 5).join('\n');
  const isDormant = /@status:\s*dormant/i.test(firstLines);
  const isActive = /@status:\s*active/i.test(firstLines);

  if (isActive) {
    results.push({
      severity: 'PASS',
      message: `模块已标记 active，无需执行 dormant 守卫`,
      file: `${relDir}/${mainFile}`,
    });
    continue;
  }

  if (!isDormant) {
    const { exempt, entry } = checkExemption(
      exemptions,
      `${relDir}/${mainFile}`,
      'dormant-no-readme',
    );
    if (exempt) {
      results.push({
        severity: 'WARN',
        message: `模块未标记 active/dormant（豁免至 ${entry!.expiresAt}）`,
        file: `${relDir}/${mainFile}`,
      });
    } else {
      results.push({
        severity: 'ERROR',
        message: `模块主文件顶部缺少 @status: dormant 或 @status: active 注释`,
        file: `${relDir}/${mainFile}`,
        detail: '请在文件顶部第 1～3 行添加状态注释。',
      });
    }
    continue;
  }

  if (!fs.existsSync(readmePath)) {
    const { exempt, expired, entry } = checkExemption(
      exemptions,
      `${relDir}/${mainFile}`,
      'dormant-no-readme',
    );
    if (exempt) {
      results.push({
        severity: 'WARN',
        message: `dormant 模块缺少 README.md（豁免至 ${entry!.expiresAt}）`,
        file: `${relDir}/README.md`,
        detail: `ADR: ${entry!.adrRef}`,
      });
    } else if (expired && entry) {
      results.push({
        severity: 'ERROR',
        message: `dormant 模块缺少 README.md（豁免已到期 ${entry.expiresAt}）`,
        file: `${relDir}/README.md`,
      });
    } else {
      results.push({
        severity: 'ERROR',
        message: `dormant 模块缺少 README.md（R-18.2.2 / R-20.8.2）`,
        file: `${relDir}/README.md`,
      });
    }
  } else {
    results.push({
      severity: 'PASS',
      message: `dormant 模块有 README.md`,
      file: `${relDir}/README.md`,
    });
  }
}

const DORMANT_IMPORT_RE = /from\s+['"](?:@\/router|\.\.\/router|\.\.\/\.\.\/router)['"/]/g;
const SCAN_FOR_IMPORT: string[] = [
  'src/composables',
  'src/views',
  'src/layouts',
  'src/store',
  'src/services',
];

const routerIndex = path.join(ROOT, 'src/router/index.ts');
const routerHeader = fs.existsSync(routerIndex)
  ? fs.readFileSync(routerIndex, 'utf-8').split('\n').slice(0, 5).join('\n')
  : '';
const shouldBlockRouterImports = /@status:\s*dormant/i.test(routerHeader);

if (shouldBlockRouterImports) {
  for (const scanDir of SCAN_FOR_IMPORT) {
    const absDir = path.join(ROOT, scanDir);
    if (!fs.existsSync(absDir)) {
      continue;
    }

    const walk = (dirPath: string): void => {
      for (const entry of fs.readdirSync(dirPath)) {
        const full = path.join(dirPath, entry);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
          continue;
        }

        if (!entry.endsWith('.ts') && !entry.endsWith('.vue')) {
          continue;
        }

        const fileContent = fs.readFileSync(full, 'utf-8');
        if (DORMANT_IMPORT_RE.test(fileContent)) {
          const relPath = path.relative(ROOT, full).replace(/\\/g, '/');
          results.push({
            severity: 'ERROR',
            message: `业务代码 import 了 dormant router 模块（R-20.8.2）`,
            file: relPath,
            detail: 'dormant 模块 MUST NOT 被业务代码 import',
          });
        }
        DORMANT_IMPORT_RE.lastIndex = 0;
      }
    };

    walk(absDir);
  }
} else {
  results.push({
    severity: 'PASS',
    message: 'router 当前不是 dormant 状态，跳过 dormant import 守卫',
    file: 'src/router/index.ts',
  });
}

results.forEach(printResult);
const hasError = summarize('check-dormant-modules', results);
process.exit(hasError ? 1 : 0);
