// fix-pnpm-overrides-migration.mjs
// 把 pnpm.overrides 从 package.json 迁移到 pnpm-workspace.yaml (pnpm v10+ 要求)
// 用法: 在项目根目录运行  node fix-pnpm-overrides-migration.mjs
import { readFile, writeFile, access } from "node:fs/promises"

const PKG = "package.json"
const WS = "pnpm-workspace.yaml"

function must(cond, msg) {
  if (!cond) {
    console.error("ABORT: " + msg)
    process.exit(1)
  }
}
async function exists(p) {
  try { await access(p); return true } catch { return false }
}

const pkgRaw = await readFile(PKG, "utf8")
const pkg = JSON.parse(pkgRaw)

const pnpmField = pkg.pnpm
const overrides = pnpmField?.overrides

const wsExists = await exists(WS)
const wsRaw = wsExists ? await readFile(WS, "utf8") : ""
const wsHasOverrides = /(^|\n)overrides:/.test(wsRaw)

// 幂等:已经迁移过(package.json 无 pnpm 字段)
if (!pnpmField) {
  must(wsHasOverrides, "package.json 已无 pnpm 字段,但 pnpm-workspace.yaml 也没有 overrides:,状态异常,请手动检查。")
  console.log("已迁移过,无需改动。")
  process.exit(0)
}

must(overrides && typeof overrides === "object", "package.json 的 pnpm 字段里没有 overrides 对象,无法迁移,请手动检查。")

// 只处理 overrides;若 pnpm 字段里还有别的设置,停下来让你手动迁移,避免丢配置
const otherKeys = Object.keys(pnpmField).filter((k) => k !== "overrides")
must(otherKeys.length === 0, `package.json 的 pnpm 字段除 overrides 外还有: ${otherKeys.join(", ")} —— 请手动迁移这些设置,避免丢失。`)

// 构造 YAML overrides 块(键值都加引号,兼容 @scope/pkg 之类的键)
const lines = Object.entries(overrides).map(
  ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(String(v))}`,
)
const block = `overrides:\n${lines.join("\n")}\n`

// 1) 写 pnpm-workspace.yaml
if (!wsExists) {
  await writeFile(WS, block, "utf8")
  console.log(`已创建 ${WS}`)
} else {
  must(!wsHasOverrides, `${WS} 里已存在 overrides: 键,请手动合并,避免覆盖现有配置。`)
  const sep = wsRaw.length && !wsRaw.endsWith("\n") ? "\n" : ""
  await writeFile(WS, wsRaw + sep + block, "utf8")
  console.log(`已向 ${WS} 追加 overrides 块`)
}

// 2) 从 package.json 删除 pnpm 字段(保留 2 空格缩进 + 末尾换行)
delete pkg.pnpm
await writeFile(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8")
console.log(`已从 ${PKG} 删除 pnpm 字段`)

console.log("完成。接下来请执行 pnpm install 让 override 真正生效。")