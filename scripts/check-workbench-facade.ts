/**
 * check-workbench-facade.ts
 * 扫描 app/**、views/** 与 layouts/**（不含 composables/ 聚合层）中对业务 store 的直接 import。
 * ≥ 2 个业务 store import 即 fail（R-18.11.1 / R-20.1.5）。
 *
 * 业务 store 定义：src/store/ 下的模块（app / editor / git 等）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    CheckResult,
    ROOT,
    checkExemption,
    loadBaseline,
    printResult,
    summarize,
} from './guard-utils.js';

/** 匹配 import ... from '@/store/xxx' 或 '../store/xxx' 等 */
const STORE_IMPORT_RE = /from\s+['"](?:@\/store|\.\.\/store|\.\.\/\.\.\/store)\/(\w+)['"]/g;

function scanFile(relPath: string): string[] {
    const absPath = path.join(ROOT, relPath);
    if (!fs.existsSync(absPath)) return [];
    const content = fs.readFileSync(absPath, 'utf-8');
    const matches: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = STORE_IMPORT_RE.exec(content)) !== null) {
        matches.push(m[1]);
    }
    return [...new Set(matches)];
}

function scanDir(dir: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) return result;
    const walk = (d: string) => {
        for (const entry of fs.readdirSync(d)) {
            const full = path.join(d, entry);
            if (fs.statSync(full).isDirectory()) {
                // composables/ 是 façade 聚合层（非视图层），按 R-18.11.1 豁免多 store 规则
                if (entry === 'composables') continue;
                walk(full);
            } else if (entry.endsWith('.vue') || entry.endsWith('.ts')) {
                const rel = path.relative(ROOT, full).replace(/\\/g, '/');
                const stores = scanFile(rel);
                if (stores.length > 0) result.set(rel, stores);
            }
        }
    };
    walk(absDir);
    return result;
}

const exemptions = loadBaseline('workbench-facade');
const results: CheckResult[] = [];

const SCAN_DIRS = ['src/app', 'src/views', 'src/layouts'];

for (const dir of SCAN_DIRS) {
    const found = scanDir(dir);
    for (const [relPath, stores] of found) {
        if (stores.length >= 2) {
            const { exempt, expired, entry } = checkExemption(exemptions, relPath, 'no-multi-business-store-import');
            if (exempt) {
                results.push({
                    severity: 'WARN',
                    message: `直接 import 了 ${stores.length} 个业务 store: [${stores.join(', ')}]（豁免至 ${entry!.expiresAt}）`,
                    file: relPath,
                    detail: `ADR: ${entry!.adrRef} | 责任人: ${entry!.owner}`,
                });
            } else if (expired && entry) {
                results.push({
                    severity: 'ERROR',
                    message: `直接 import 了 ${stores.length} 个业务 store: [${stores.join(', ')}]（豁免已于 ${entry.expiresAt} 到期）`,
                    file: relPath,
                });
            } else {
                results.push({
                    severity: 'ERROR',
                    message: `直接 import 了 ${stores.length} 个业务 store: [${stores.join(', ')}]（违反 R-18.11.1）`,
                    file: relPath,
                    detail: '视图层 MUST NOT 在同一文件内直接 import 超过一个业务 store',
                });
            }
        } else {
            results.push({
                severity: 'PASS',
                message: `store import 合规（${stores.length} 个: ${stores.join(', ')}）`,
                file: relPath,
            });
        }
    }
}

results.forEach(printResult);
const hasError = summarize('check-workbench-facade', results);
process.exit(hasError ? 1 : 0);
