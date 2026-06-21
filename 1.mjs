// setup-tsgo.mjs
// 用途：把 tsgo (TS7 native preview) 接成「非 .vue 纯 TS」的副跑加速实验，
//      不碰现有 vue-tsc 主门禁。幂等，可重复执行。
// 运行：node setup-tsgo.mjs  （仓库根目录）
import { readFileSync, writeFileSync, existsSync } from "node:fs"

const NATIVE_PKG = "@typescript/native-preview"
const NATIVE_VER = "latest" // 预览包滚动更新，先用 latest；想锁版本自行替换
const TSCONFIG = "tsconfig.tsgo.json"

// 在保持原有 key 顺序的前提下，在某个锚点 key 之后插入新 key
function insertAfter(obj, anchorKey, newKey, newVal) {
	if (newKey in obj) return obj // 幂等：已存在则不动
	const out = {}
	let inserted = false
	for (const [k, v] of Object.entries(obj)) {
		out[k] = v
		if (k === anchorKey) {
			out[newKey] = newVal
			inserted = true
		}
	}
	if (!inserted) out[newKey] = newVal // 找不到锚点就追加到末尾
	return out
}

// 1) 改 package.json：加 devDependency + typecheck:fast 脚本
const pkgPath = "package.json"
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))

const beforeScript = JSON.stringify(pkg.scripts)
const beforeDeps = JSON.stringify(pkg.devDependencies)

pkg.scripts = insertAfter(
	pkg.scripts,
	"typecheck",
	"typecheck:fast",
	`tsgo --noEmit -p ${TSCONFIG}`,
)
pkg.devDependencies = insertAfter(
	pkg.devDependencies,
	"@types/node",
	NATIVE_PKG,
	NATIVE_VER,
)

const pkgChanged =
	JSON.stringify(pkg.scripts) !== beforeScript ||
	JSON.stringify(pkg.devDependencies) !== beforeDeps
if (pkgChanged) {
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
	console.log("✓ package.json：已加 typecheck:fast + " + NATIVE_PKG)
} else {
	console.log("· package.json：已是最新，跳过")
}

// 2) 写隔离的 tsconfig.tsgo.json（无 baseUrl —— TS7 已移除）
//    默认只覆盖 scripts/，避免 .vue 与别名解析噪音。
//    agent-sidecar 是纯 TS，确认无 .vue 依赖后可解开下面那行。
const tsgoConfig = {
	compilerOptions: {
		module: "ESNext",
		target: "ESNext",
		moduleResolution: "bundler",
		skipLibCheck: true,
		resolveJsonModule: true,
		isolatedModules: true,
		noEmit: true,
		strict: true,
		types: ["node"],
	},
	include: [
		"scripts/**/*.ts",
		// "agent-sidecar/src/**/*.ts",
	],
}
const tsgoText = JSON.stringify(tsgoConfig, null, 2) + "\n"
if (!existsSync(TSCONFIG) || readFileSync(TSCONFIG, "utf8") !== tsgoText) {
	writeFileSync(TSCONFIG, tsgoText)
	console.log(`✓ ${TSCONFIG}：已写入`)
} else {
	console.log(`· ${TSCONFIG}：无变化，跳过`)
}

console.log(
	"\n下一步：\n" +
		"  pnpm install\n" +
		"  pnpm typecheck:fast        # tsgo 跑 scripts/ 纯 TS 检查\n" +
		"  pnpm typecheck             # 原 vue-tsc 主门禁，对照差异\n" +
		"\n注意：装好后若命令名是 tsc 而非 tsgo，把 typecheck:fast 里的 tsgo 改成 tsc。",
)