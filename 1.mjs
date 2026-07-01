// tune-dev-profile.mjs
// 给 src-tauri/Cargo.toml 追加 [profile.dev] 调优段，降低 dev 构建的 LLVM 内存/时间。
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'

const FILE = 'src-tauri/Cargo.toml'
const MARKER = '[profile.dev]'
const BLOCK = `
# 降低 dev(debug)构建的内存/时间开销：
# 默认 debug=2(完整调试信息)会让最终 calamex 二进制的 LLVM 代码生成占用大量内存，
# 在 vite+node+cargo 并发的 tauri dev 下容易 OOM。line-tables-only 保留 panic 栈行号。
[profile.dev]
debug = "line-tables-only"

# 依赖不需要调试信息，进一步降低峰值内存与磁盘占用。
[profile.dev.package."*"]
debug = false
`

if (!existsSync(FILE)) { console.error(`[abort] 不存在：${FILE}`); process.exit(1) }
let src = readFileSync(FILE, 'utf8')
if (src.includes(MARKER)) {
  console.log('[ok] 已存在 [profile.dev]，跳过')
} else {
  copyFileSync(FILE, `${FILE}.bak`)
  if (!src.endsWith('\n')) src += '\n'
  src += BLOCK
  writeFileSync(FILE, src, 'utf8')
  console.log('[done] 已追加 [profile.dev] 调优段')
}