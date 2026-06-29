// Finding E 修复：删除 useIntegratedTerminal.ts 中 cancelRun 的多余 'graceful' 实参
// 用法：在仓库根目录 D:\com.xiaojianc\my_desktop_app 下执行 node 2.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'src/domains/terminal/composables/useIntegratedTerminal.ts'

function die(msg) {
  console.error('✘ ' + msg)
  process.exit(1)
}

const raw = readFileSync(FILE, 'utf8')

// CRLF 安全：记录原始换行风格，统一成 LF 处理，写回时还原
const usesCRLF = raw.includes('\r\n')
let src = usesCRLF ? raw.replace(/\r\n/g, '\n') : raw

const FROM = "terminalFacade.cancelRun(runId, 'graceful')"
const TO = 'terminalFacade.cancelRun(runId)'

// 必须精确命中 1 次
const count = src.split(FROM).length - 1
if (count !== 1) {
  die(`预期命中 1 次「${FROM}」，实际 ${count} 次，已中止且未写入。`)
}

src = src.replace(FROM, TO)

// 后置校验
if (src.includes("'graceful'")) die('替换后仍残留「graceful」字面量，已中止。')
if (!src.includes(TO)) die('替换后未找到 cancelRun(runId)，已中止。')
// 回退逻辑依赖后端错误文案「不支持带外取消」，必须保留
if (!src.includes('不支持带外取消')) die('回退逻辑依赖的「不支持带外取消」意外丢失，已中止。')

const out = usesCRLF ? src.replace(/\n/g, '\r\n') : src
writeFileSync(FILE, out, 'utf8')
console.log('✔ 已更新 ' + FILE + '：cancelRun(runId, graceful) → cancelRun(runId)')