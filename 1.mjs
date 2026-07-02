// scripts/fix-p8-emit-output-log.mjs   用法：node 1.mjs
// 作用：agent.ts 的 emitOutputEvent 里吞错的空 catch → 改为 stderr 记录（stdout 是协议线路，绝不能写）
import { readFile, writeFile } from "node:fs/promises"

const FILE = "builtin-agent/src/acp/agent.ts"
const src = await readFile(FILE, "utf8")

const OLD = ".catch(() => {})"
const NEW =
  `.catch((err) => {\n\t\t\t\tprocess.stderr.write(\n\t\t\t\t\t\`[acp] emitOutputEvent 写失败：\${err instanceof Error ? (err.stack ?? err.message) : String(err)}\\n\`,\n\t\t\t\t)\n\t\t\t})`

if (!src.includes(OLD)) {
  console.error("未找到目标片段，可能已修复或行文已变，请手动核对：", FILE)
  process.exit(1)
}
const count = src.split(OLD).length - 1
if (count > 1) {
  console.error(`发现 ${count} 处 \`${OLD}\`，为避免误伤请手动定位 emitOutputEvent 内那一处。`)
  process.exit(1)
}
await writeFile(FILE, src.replace(OLD, NEW), "utf8")
console.log("✅ P8 已修复：emitOutputEvent 写失败现在会记录到 stderr（原本被静默吞掉）。")