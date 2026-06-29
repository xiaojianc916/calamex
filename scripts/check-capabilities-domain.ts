/**
 * check-capabilities-domain.ts
 * 校验 src-tauri/capabilities/ 下必须存在 5 个域文件（R-7.4.1 / R-18.12.5 / R-20.5.8）
 *
 * 必需域文件：
 *   window.json
 *   workspace-fs.json
 *   script-toolchain.json
 *   terminal.json
 *   git.json
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

const CAPABILITIES_DIR = path.join(ROOT, 'src-tauri/capabilities');
const REQUIRED_DOMAINS = [
  'window.json',
  'workspace-fs.json',
  'script-toolchain.json',
  'terminal.json',
  'git.json',
];

const exemptions = loadBaseline('capability-domains');
const results: CheckResult[] = [];

for (const domain of REQUIRED_DOMAINS) {
  const fullPath = path.join(CAPABILITIES_DIR, domain);
  const relPath = `src-tauri/capabilities/${domain}`;
  if (fs.existsSync(fullPath)) {
    // 检查是否有通配符权限
    const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    const permissions: string[] = content.permissions ?? [];
    const wildcards = permissions.filter((p: string) => p.includes('*'));
    if (wildcards.length > 0) {
      results.push({
        severity: 'ERROR',
        message: `${domain} 包含通配符权限（违反 R-7.4.2）`,
        file: relPath,
        detail: `通配符权限: ${wildcards.join(', ')}`,
      });
    } else {
      results.push({ severity: 'PASS', message: `${domain} 存在且无通配符`, file: relPath });
    }
  } else {
    const { exempt, expired, entry } = checkExemption(
      exemptions,
      relPath,
      'missing-capability-domain',
    );
    if (exempt) {
      results.push({
        severity: 'WARN',
        message: `${domain} 不存在（豁免至 ${entry!.expiresAt}）`,
        file: relPath,
        detail: `ADR: ${entry!.adrRef}`,
      });
    } else if (expired && entry) {
      results.push({
        severity: 'ERROR',
        message: `${domain} 不存在，豁免已于 ${entry.expiresAt} 到期`,
        file: relPath,
      });
    } else {
      results.push({
        severity: 'ERROR',
        message: `${domain} 不存在（违反 R-7.4.1 / R-18.12.5）`,
        file: relPath,
        detail: '请在 src-tauri/capabilities/ 下创建对应域文件',
      });
    }
  }
}

results.forEach(printResult);
const hasError = summarize('check-capabilities-domain', results);
process.exit(hasError ? 1 : 0);
