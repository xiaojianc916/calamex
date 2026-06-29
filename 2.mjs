#!/usr/bin/env node
// scripts/fix-terminal-residuals.mjs
// 清理 terminal 领域化后的残留旧路径：
//   1) vite.config.ts 的 manualChunks 分块规则路径
//   2) src/domains/terminal/ 内注释/字面量里的旧路径前缀
// 默认 dry-run；--apply 落盘。
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const av = process.argv.slice(2)
const APPLY = av.includes('--apply')
let ROOT_ARG = null
for (let i = 0; i < av.length; i++) {
	if (av[i] === '--root') ROOT_ARG = av[++i]
	else if (av[i].startsWith('--root=')) ROOT_ARG = av[i].slice('--root='.length)
}
const isFile = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const marker = (d) => !!d && isFile(path.join(d, 'package.json')) && isDir(path.join(d, 'src'))
function detectRoot() {
	if (ROOT_ARG) { const r = path.resolve(ROOT_ARG); if (marker(r)) return r; console.error('--root 无效：' + r); process.exit(1) }
	try { const t = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (marker(t)) return t } catch {}
	let d = process.cwd(); while (true) { if (marker(d)) return d; const p = path.dirname(d); if (p === d) break; d = p }
	console.error('无法定位仓库根，请用 --root 指定'); process.exit(1)
}
const ROOT = detectRoot()

// 仅整目录搬迁的前缀可盲替换（与主迁移脚本的 PURE_DIRS 一致）
const PREFIX = [
	['src/terminal/',          'src/domains/terminal/core/'],
	['src/services/terminal/', 'src/domains/terminal/services/'],
	['src/utils/terminal/',    'src/domains/terminal/utils/'],
	['@/terminal/',            '@/domains/terminal/core/'],
	['@/services/terminal/',   '@/domains/terminal/services/'],
	['@/utils/terminal/',      '@/domains/terminal/utils/'],
]
const SKIP = new Set(['node_modules', 'dist', 'target', '.git'])
function walk(dir, acc = []) {
	for (const n of fs.readdirSync(dir)) {
		if (SKIP.has(n)) continue
		const f = path.join(dir, n); const s = fs.statSync(f)
		if (s.isDirectory()) walk(f, acc); else acc.push(f)
	}
	return acc
}
const plan = []
// 1) 领域目录内的陈旧字面量/注释
const domainDir = path.join(ROOT, 'src', 'domains', 'terminal')
if (isDir(domainDir)) {
	for (const f of walk(domainDir).filter((x) => /\.(ts|tsx|mts|cts|js|mjs|vue)$/i.test(x))) {
		let out = fs.readFileSync(f, 'utf8'); const before = out
		for (const [o, w] of PREFIX) if (out.includes(o)) out = out.split(o).join(w)
		if (out !== before) plan.push({ f, out })
	}
}
// 2) vite.config.ts 分块规则（带前导斜杠，仅这两条 utils/terminal）
const vite = path.join(ROOT, 'vite.config.ts')
if (isFile(vite)) {
	let out = fs.readFileSync(vite, 'utf8'); const before = out
	out = out.split('/src/utils/terminal/shell-completion.ts').join('/src/domains/terminal/utils/shell-completion.ts')
	out = out.split('/src/utils/terminal/shfmt.ts').join('/src/domains/terminal/utils/shfmt.ts')
	if (out !== before) plan.push({ f: vite, out })
}

if (!plan.length) { console.log('没有需要修复的残留。'); process.exit(0) }
for (const p of plan) console.log((APPLY ? '[ok]  ' : '[dry] ') + 'fix', path.relative(ROOT, p.f).split(path.sep).join('/'))
if (!APPLY) { console.log('\n[dry] 未写入。确认后：node fix-terminal-residuals.mjs --apply'); process.exit(0) }
for (const p of plan) fs.writeFileSync(p.f, p.out)
console.log('\n[done] 已修复 ' + plan.length + ' 个文件。')