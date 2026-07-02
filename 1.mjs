#!/usr/bin/env node
// 绕过 pnpm bug #10528：allowBuilds 里设 false 不会让 .modules.yaml 缓存失效，
// 导致 pnpm install 仍报 ERR_PNPM_IGNORED_BUILDS。删掉这个缓存文件即可让"拒绝构建"的决定生效。
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const ROOT = process.cwd()
const target = path.join(ROOT, "node_modules", ".modules.yaml")

if (fs.existsSync(target)) {
	fs.rmSync(target)
	console.log("✎ 已删除陈旧缓存：node_modules/.modules.yaml")
} else {
	console.log("✓ 无需处理：node_modules/.modules.yaml 不存在")
}
console.log("\n── 接着跑 ──")
console.log("pnpm install")
console.log('git commit -m "fix(core): 修复已知问题"')