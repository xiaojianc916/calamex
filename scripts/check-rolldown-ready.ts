#!/usr/bin/env node
/**
 * 确认项目走 Rolldown 路线：
 * - 当前首选 Vite 8（已由 Rolldown 驱动）；
 * - 若需要隔离验证，也允许把 vite alias 到 npm:rolldown-vite@固定版本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const viteSpec = pkg.devDependencies?.vite ?? pkg.dependencies?.vite ?? '';
const viteMajor = Number.parseInt(viteSpec.match(/\d+/u)?.[0] ?? '', 10);
const usesRolldownViteAlias = viteSpec.startsWith('npm:rolldown-vite@');
const usesVite8 = Number.isInteger(viteMajor) && viteMajor >= 8;

if (usesRolldownViteAlias || usesVite8) {
  console.log(`[check-rolldown-ready] PASS vite=${viteSpec}`);
  process.exit(0);
}

console.error(
  `[check-rolldown-ready] FAIL vite=${viteSpec || '<missing>'}. ` +
    '请升级到 Vite 8+，或临时 alias 为 npm:rolldown-vite@固定版本。',
);
process.exit(1);
