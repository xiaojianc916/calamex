/**
 * 守卫脚本公共工具库
 * 为所有 check-*.ts 提供豁免清单加载、结果汇报等基础能力。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export interface Exemption {
  path: string;
  rule: string;
  reason: string;
  owner: string;
  adrRef: string;
  expiresAt: string; // YYYY-MM-DD
}

export interface BaselineFile {
  description: string;
  exemptions: Exemption[];
}

/** 加载豁免清单 */
export function loadBaseline(name: string): Exemption[] {
  const file = path.join(ROOT, 'scripts', 'baselines', `${name}.json`);
  if (!fs.existsSync(file)) return [];
  const data: BaselineFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return data.exemptions ?? [];
}

/** 检查某路径+规则是否在豁免清单内（含到期检测） */
export function checkExemption(
  exemptions: Exemption[],
  filePath: string,
  rule: string,
): { exempt: boolean; expired: boolean; entry?: Exemption } {
  // 规范化路径比较（统一使用正斜杠）
  const normalizeP = (p: string) => p.replace(/\\/g, '/');
  const entry = exemptions.find(
    (e) => normalizeP(e.path) === normalizeP(filePath) && e.rule === rule,
  );
  if (!entry) return { exempt: false, expired: false };
  const expired = new Date(entry.expiresAt) < new Date();
  return { exempt: !expired, expired, entry };
}

export type Severity = 'PASS' | 'WARN' | 'ERROR';

export interface CheckResult {
  severity: Severity;
  message: string;
  file?: string;
  detail?: string;
}

/** 打印结果行 */
export function printResult(result: CheckResult): void {
  const prefix =
    result.severity === 'ERROR'
      ? '\x1b[31m[ERROR]\x1b[0m'
      : result.severity === 'WARN'
        ? '\x1b[33m[WARN]\x1b[0m'
        : '\x1b[32m[PASS]\x1b[0m';
  const loc = result.file ? ` ${result.file}` : '';
  const detail = result.detail ? `\n        ${result.detail}` : '';
  console.log(`${prefix}${loc} ${result.message}${detail}`);
}

/** 聚合多个结果，返回运行是否有 ERROR */
export function summarize(name: string, results: CheckResult[]): boolean {
  const errors = results.filter((r) => r.severity === 'ERROR');
  const warns = results.filter((r) => r.severity === 'WARN');
  if (errors.length === 0 && warns.length === 0) {
    console.log(`\x1b[32m✓ ${name} — 全部通过\x1b[0m`);
  } else {
    if (warns.length > 0) console.log(`\x1b[33m⚠ ${name} — ${warns.length} 条警告\x1b[0m`);
    if (errors.length > 0) console.log(`\x1b[31m✗ ${name} — ${errors.length} 条错误\x1b[0m`);
  }
  return errors.length > 0;
}

/** 计算文件行数（仅计非空行也可，这里计总行数） */
export function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  return content.split('\n').length;
}

/** 计算 <script setup> 行数 */
export function countScriptSetupLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/<script\s+setup[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return 0;
  return match[1].split('\n').length;
}
