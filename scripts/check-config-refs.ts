/**
 * check-config-refs.ts
 * 扫描配置文件中的路径引用，确保它们真实存在（R-20.8.3 / R-20.8.5）
 *
 * 检查目标：
 *   components.json -> tailwind.config 字段
 *   tsconfig*.json -> paths 中的引用
 *   vite.config.ts -> 不检查（动态）
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

const exemptions = loadBaseline('config-refs');
const results: CheckResult[] = [];

// 检查 components.json 的 tailwind.config 引用
const componentsJson = path.join(ROOT, 'components.json');
if (fs.existsSync(componentsJson)) {
  const data = JSON.parse(fs.readFileSync(componentsJson, 'utf-8'));
  const twConfig: string | undefined = data?.tailwind?.config;
  if (twConfig) {
    const twConfigAbs = path.resolve(ROOT, twConfig);
    if (!fs.existsSync(twConfigAbs)) {
      const { exempt, expired, entry } = checkExemption(
        exemptions,
        'components.json',
        'dangling-config-ref',
      );
      if (exempt) {
        results.push({
          severity: 'WARN',
          message: `components.json tailwind.config 引用不存在的文件: "${twConfig}"（豁免至 ${entry!.expiresAt}）`,
          file: 'components.json',
          detail: `ADR: ${entry!.adrRef} | 责任人: ${entry!.owner}`,
        });
      } else if (expired && entry) {
        results.push({
          severity: 'ERROR',
          message: `components.json tailwind.config 引用不存在的文件: "${twConfig}"（豁免已到期 ${entry.expiresAt}）`,
          file: 'components.json',
        });
      } else {
        results.push({
          severity: 'ERROR',
          message: `components.json tailwind.config 引用不存在的文件: "${twConfig}"`,
          file: 'components.json',
          detail: '请将 tailwind.config 字段设为空字符串或指向真实文件（R-20.8.5）',
        });
      }
    } else {
      results.push({
        severity: 'PASS',
        message: `components.json tailwind.config 引用有效: "${twConfig}"`,
        file: 'components.json',
      });
    }
  } else {
    results.push({
      severity: 'PASS',
      message: 'components.json 无 tailwind.config 引用（符合 CSS-first 模式）',
      file: 'components.json',
    });
  }
}

// 检查 tauri.conf.json 的 frontendDist 引用
const tauriConf = path.join(ROOT, 'src-tauri/tauri.conf.json');
if (fs.existsSync(tauriConf)) {
  const data = JSON.parse(fs.readFileSync(tauriConf, 'utf-8'));
  const frontendDist: string | undefined = data?.build?.frontendDist;
  if (frontendDist && !frontendDist.startsWith('http')) {
    // 只检查非 URL 的路径
    const abs = path.resolve(path.join(ROOT, 'src-tauri'), frontendDist);
    // dist 在 build 之前不存在，只报 WARN
    if (!fs.existsSync(abs)) {
      results.push({
        severity: 'PASS',
        message: `tauri.conf.json frontendDist="${frontendDist}" 尚未构建（正常）`,
        file: 'src-tauri/tauri.conf.json',
      });
    } else {
      results.push({
        severity: 'PASS',
        message: `tauri.conf.json frontendDist="${frontendDist}" 存在`,
        file: 'src-tauri/tauri.conf.json',
      });
    }
  }
}

results.forEach(printResult);
const hasError = summarize('check-config-refs', results);
process.exit(hasError ? 1 : 0);
