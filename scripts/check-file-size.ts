/**
 * check-file-size.ts
 * 文件行数守卫：全量扫描 src/ 与 src-tauri/src/，按扩展名阈值 + 路径特例校验。
 * 超限文件必须在 scripts/baselines/file-size.json 登记豁免（受控债务），
 * 否则视为新增违规并使守卫失败。
 *
 * 阈值（默认，按扩展名）：
 *   *.rs   ≤ 800 行（普通源文件；commands/mod.rs 特例 ≤ 80，见 PATH_OVERRIDES）
 *   *.ts   ≤ 400 行（main.ts 特例 ≤ 120，内联 DOM 近似）
 *   *.vue  ≤ 120 行（仅计 <script setup>）
 *   *.css  ≤ 1500 行
 * 规则：R-20.1.3 / R-20.1.4 / R-20.5.1 / R-20.6.3
 *
 * 用法：
 *   tsx scripts/check-file-size.ts                    仅校验并汇报
 *   tsx scripts/check-file-size.ts --update-baseline   将当前所有超限文件登记为豁免（渐进还债）
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  CheckResult,
  checkExemption,
  countLines,
  countScriptSetupLines,
  Exemption,
  loadBaseline,
  printResult,
  ROOT,
  summarize,
} from './guard-utils.js';

/** 扫描根目录（相对仓库根） */
const SCAN_ROOTS = ['src', 'src-tauri/src'];

/** 跳过的目录名（生成产物 / 依赖 / 构建输出 / 测试目录） */
const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  'generated',
  'bindings',
  '__tests__',
  '__mocks__',
]);

/** 跳过的文件（测试 / 类型声明 / 生成的契约镜像，禁止手改的生成物不纳入治理） */
function shouldSkipFile(rel: string): boolean {
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(rel) ||
    rel.endsWith('.d.ts') ||
    rel.endsWith('tauri.contracts.ts')
  );
}

interface LimitRule {
  ruleId: string;
  limit: number;
  measure: (absPath: string) => number;
  unit: string;
}

/** 路径特例（比扩展名默认更严格）。键为相对仓库根的正斜杠路径。 */
const PATH_OVERRIDES: Record<string, LimitRule> = {
  'src-tauri/src/commands/mod.rs': {
    ruleId: 'max-lines-80',
    limit: 80,
    measure: countLines,
    unit: '行',
  },
  'src/main.ts': {
    ruleId: 'max-inline-dom-120',
    limit: 120,
    measure: countLines,
    unit: '行',
  },
};

/** 按扩展名的默认阈值 */
function defaultRuleFor(rel: string): LimitRule | null {
  if (rel.endsWith('.vue'))
    return {
      ruleId: 'max-script-setup-120',
      limit: 120,
      measure: countScriptSetupLines,
      unit: '行(script setup)',
    };
  if (rel.endsWith('.rs'))
    return { ruleId: 'max-lines-800', limit: 800, measure: countLines, unit: '行' };
  if (rel.endsWith('.ts'))
    return { ruleId: 'max-lines-400', limit: 400, measure: countLines, unit: '行' };
  if (rel.endsWith('.css'))
    return { ruleId: 'max-lines-css-1500', limit: 1500, measure: countLines, unit: '行' };
  return null;
}

function ruleFor(rel: string): LimitRule | null {
  return PATH_OVERRIDES[rel] ?? defaultRuleFor(rel);
}

/** 递归收集文件绝对路径 */
function walk(absDir: string, acc: string[]): void {
  if (!fs.existsSync(absDir)) return;
  for (const name of fs.readdirSync(absDir)) {
    const abs = path.join(absDir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(abs, acc);
    } else {
      acc.push(abs);
    }
  }
}

interface Violation {
  rel: string;
  rule: LimitRule;
  count: number;
}

// ---- 扫描 ----
const files: string[] = [];
for (const root of SCAN_ROOTS) walk(path.join(ROOT, root), files);

let scanned = 0;
const violations: Violation[] = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  if (shouldSkipFile(rel)) continue;
  const rule = ruleFor(rel);
  if (!rule) continue;
  scanned++;
  const count = rule.measure(abs);
  if (count > rule.limit) violations.push({ rel, rule, count });
}

// ---- --update-baseline：把当前超限文件登记为豁免（渐进还债） ----
const SEED = process.argv.includes('--update-baseline') || process.argv.includes('--seed');
if (SEED) {
  const baselinePath = path.join(ROOT, 'scripts', 'baselines', 'file-size.json');
  const raw = fs.existsSync(baselinePath)
    ? (JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as {
        $schema?: string;
        description: string;
        exemptions: Exemption[];
      })
    : { description: '文件行数守卫豁免清单', exemptions: [] as Exemption[] };
  const have = new Set(
    (raw.exemptions ?? []).map((e) => `${e.path.replace(/\\/g, '/')}::${e.rule}`),
  );
  let added = 0;
  for (const v of violations) {
    const key = `${v.rel}::${v.rule.ruleId}`;
    if (have.has(key)) continue;
    raw.exemptions.push({
      path: v.rel,
      rule: v.rule.ruleId,
      reason: `存量超限：登记时 ${v.count} ${v.rule.unit} > ${v.rule.limit}，待按 R-20.x 拆分还债`,
      owner: '@xiaojianc',
      adrRef: 'ADR-0003',
      expiresAt: '2026-12-31',
    });
    have.add(key);
    added++;
  }
  fs.writeFileSync(baselinePath, `${JSON.stringify(raw, null, 4)}\n`, 'utf-8');
  console.log(
    `\x1b[36m[seed]\x1b[0m 扫描 ${scanned} 个文件，新增 ${added} 条豁免，合计 ${raw.exemptions.length} 条 → ${path.relative(ROOT, baselinePath)}`,
  );
  process.exit(0);
}

// ---- 校验汇报 ----
const exemptions = loadBaseline('file-size');
const results: CheckResult[] = [];
for (const v of violations) {
  const { exempt, expired, entry } = checkExemption(exemptions, v.rel, v.rule.ruleId);
  if (exempt && entry) {
    results.push({
      severity: 'WARN',
      message: `${v.rel} = ${v.count} ${v.rule.unit} > ${v.rule.limit}（豁免至 ${entry.expiresAt}）`,
      file: v.rel,
      detail: `原因: ${entry.reason} | ADR: ${entry.adrRef} | 责任人: ${entry.owner}`,
    });
  } else if (expired && entry) {
    results.push({
      severity: 'ERROR',
      message: `${v.rel} = ${v.count} ${v.rule.unit} > ${v.rule.limit}（豁免已于 ${entry.expiresAt} 到期）`,
      file: v.rel,
      detail: `请整改或重新申请豁免（ADR: ${entry.adrRef}）`,
    });
  } else {
    results.push({
      severity: 'ERROR',
      message: `${v.rel} = ${v.count} ${v.rule.unit} > ${v.rule.limit}（无豁免条目）`,
      file: v.rel,
      detail:
        '新增违规：请整改，或运行 `pnpm exec tsx scripts/check-file-size.ts --update-baseline` 将存量登记为受控债务',
    });
  }
}

console.log(
  `\x1b[36m[check-file-size]\x1b[0m 已扫描 ${scanned} 个源文件，发现 ${violations.length} 个超限文件`,
);
results.forEach(printResult);
const hasError = summarize('check-file-size', results);
process.exit(hasError ? 1 : 0);
