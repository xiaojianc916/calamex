#!/usr/bin/env node
// find-vvs.mjs —— 扫描仓库内所有 vue-virtual-scroller 使用点并分类输出（只读，不修改任何文件）
// 用法:
//   node find-vvs.mjs                  扫描默认目录 src 与 agent-sidecar/src
//   node find-vvs.mjs src              只扫描 src
//   node find-vvs.mjs --json           以 JSON 输出（便于喂给后续重构）
//   node find-vvs.mjs --json > vvs.json
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"

const argv = process.argv.slice(2)
const asJson = argv.includes("--json")
const roots = argv.filter((a) => !a.startsWith("--"))
const SCAN_ROOTS = roots.length ? roots : ["src", "agent-sidecar/src"]

const EXTS = new Set([".vue", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "target", ".git",
  ".output", "coverage", "src-tauri/target",
])

// 分类规则：specific 在前，兜底在后。每行可命中多条。
const RULES = [
  { cat: "import-css",            re: /vue-virtual-scroller\/dist\/[^'"]*\.css/ },
  { cat: "import",                re: /\bfrom\s+['"]vue-virtual-scroller['"]/ },
  { cat: "import-bare",           re: /\bimport\s+['"]vue-virtual-scroller(\/[^'"]*)?['"]/ },
  { cat: "require",               re: /require\(\s*['"]vue-virtual-scroller['"]\s*\)/ },
  { cat: "plugin-use",            re: /\.use\(\s*VueVirtualScroller\b/ },
  { cat: "tag:RecycleScroller",   re: /<\/?(RecycleScroller|recycle-scroller)\b/ },
  { cat: "tag:DynamicScrollerItem", re: /<\/?(DynamicScrollerItem|dynamic-scroller-item)\b/ },
  { cat: "tag:DynamicScroller",   re: /<\/?(DynamicScroller(?!Item)|dynamic-scroller(?!-item))\b/ },
  { cat: "other",                 re: /vue-virtual-scroller|RecycleScroller|DynamicScroller/ },
]

/** 递归收集待扫描文件 */
async function walk(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out // 目录不存在则跳过
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      await walk(full, out)
    } else if (EXTS.has(e.name.slice(e.name.lastIndexOf("."))) || e.name.endsWith(".vue")) {
      out.push(full)
    }
  }
  return out
}

function classifyLine(line) {
  const hits = new Set()
  for (const { cat, re } of RULES) if (re.test(line)) hits.add(cat)
  // 命中了更具体的标签/导入分类时，丢弃 "other" 兜底，避免重复噪音
  if (hits.size > 1) hits.delete("other")
  return [...hits]
}

const findings = [] // { file, line, text, cats }
for (const root of SCAN_ROOTS) {
  const files = await walk(root)
  for (const file of files) {
    let content
    try {
      content = await readFile(file, "utf8")
    } catch {
      continue
    }
    if (!content.includes("vue-virtual-scroller") &&
        !/RecycleScroller|DynamicScroller/.test(content)) continue
    const lines = content.split(/\r?\n/)
    lines.forEach((text, i) => {
      const cats = classifyLine(text)
      if (cats.length) {
        findings.push({ file: relative(process.cwd(), file), line: i + 1, text: text.trim(), cats })
      }
    })
  }
}

if (asJson) {
  console.log(JSON.stringify(findings, null, 2))
  process.exit(0)
}

// —— 人类可读报告 ——
if (findings.length === 0) {
  console.log("✅ 未发现 vue-virtual-scroller 的任何使用点。")
  process.exit(0)
}

const byFile = new Map()
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}
const catCount = {}
for (const f of findings) for (const c of f.cats) catCount[c] = (catCount[c] ?? 0) + 1

console.log(`\n🔍 共在 ${byFile.size} 个文件中发现 ${findings.length} 处使用点\n`)
for (const [file, items] of byFile) {
  console.log(`📄 ${file}`)
  for (const it of items) {
    console.log(`   L${String(it.line).padEnd(4)} [${it.cats.join(", ")}]  ${it.text}`)
  }
  console.log("")
}
console.log("📊 分类统计:")
for (const [c, n] of Object.entries(catCount).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${c.padEnd(24)} ${n}`)
}

// 需要手动改写模板的文件（含组件标签的）
const needRewrite = [...byFile.entries()]
  .filter(([, items]) => items.some((i) => i.cats.some((c) => c.startsWith("tag:"))))
  .map(([file]) => file)
if (needRewrite.length) {
  console.log("\n⚠️  以下文件含组件标签，需手动改写为 @tanstack/vue-virtual（headless）:")
  for (const f of needRewrite) console.log(`   - ${f}`)
}
console.log("")