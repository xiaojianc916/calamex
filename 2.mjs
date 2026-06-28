#!/usr/bin/env node
// 在仓库根目录运行: node <此文件>
// 清零剩余 26 处 orchestrate 残留(3 文件):
//  A) useAiAssistant.spec.ts: 成块删除 3 个 orchestrate 测试 + 全部 mock 管线(导入/定义/装配/reset/vi.mock)
//  B) explorer.boundary.md / ssh.boundary.md: 无关英文词 orchestration -> coordination
// 设计: 锚点成块删除(不复述长文本) + 唯一字面删除; 每步校验命中唯一、删后该文件 orchestrate 清零; 幂等。

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = process.cwd()
const ORCH = /orchestrat(?!or)/i

const detectEol = (t) => (t.includes('\r\n') ? '\r\n' : '\n')

// 删除 [startMarker, endMarker) 区间(保留 endMarker 起的内容)。start 找不到=已删,幂等跳过。
const removeBetween = (text, startMarker, endMarker, label) => {
  const s = text.indexOf(startMarker)
  if (s === -1) return { text, applied: false }
  const e = text.indexOf(endMarker)
  if (e === -1) throw new Error(`${label}: 找不到结束锚点`)
  if (e <= s) throw new Error(`${label}: 结束锚点在开始之前`)
  return { text: text.slice(0, s) + text.slice(e), applied: true }
}

// 删除一组连续整行(含行尾)。命中 0=幂等跳过, >1=拒绝模糊删除。
const removeLines = (text, lines, eol, label) => {
  const block = lines.join(eol) + eol
  const count = text.split(block).length - 1
  if (count === 0) return { text, applied: false }
  if (count > 1) throw new Error(`${label}: 命中 ${count} 次(要求唯一)`)
  return { text: text.replace(block, ''), applied: true }
}

const replaceOnce = (text, from, to, label) => {
  const count = text.split(from).length - 1
  if (count === 0) return { text, applied: false }
  if (count > 1) throw new Error(`${label}: 命中 ${count} 次(要求唯一)`)
  return { text: text.replace(from, to), applied: true }
}

// ========== A) useAiAssistant.spec.ts ==========
{
  const path = resolve(repoRoot, 'src/composables/ai/useAiAssistant.spec.ts')
  let text = readFileSync(path, 'utf8')
  const eol = detectEol(text)
  const original = text
  let n = 0
  const step = (r) => { text = r.text; if (r.applied) n += 1 }

  // 1) 类型导入(2 行)
  step(removeLines(text, [
    '  IAgentSidecarOrchestrateRequest,',
    '  IAgentSidecarOrchestrateResumeRequest,',
  ], eol, 'spec/imports'))

  // 2) 两个 mock 定义块: 删 [sidecarOrchestrate, onSidecarStream)，保留 onSidecarStream
  step(removeBetween(
    text,
    '  const sidecarOrchestrate = vi.fn(async (request: IAgentSidecarOrchestrateRequest) => {',
    '  const onSidecarStream = vi.fn(async (handler: SidecarStreamHandler) => {',
    'spec/mockDefs',
  ))

  // 3) 返回对象装配(2 行)
  step(removeLines(text, [
    '    sidecarOrchestrate,',
    '    sidecarOrchestrateResume,',
  ], eol, 'spec/return'))

  // 4) reset() 里的 mockClear(2 行)
  step(removeLines(text, [
    '      sidecarOrchestrate.mockClear();',
    '      sidecarOrchestrateResume.mockClear();',
  ], eol, 'spec/reset'))

  // 5) vi.mock('@/services/ipc/ai.service') 工厂(2 行)
  step(removeLines(text, [
    '    sidecarOrchestrate: aiServiceMock.sidecarOrchestrate,',
    '    sidecarOrchestrateResume: aiServiceMock.sidecarOrchestrateResume,',
  ], eol, 'spec/viMock'))

  // 6) 三个相邻 orchestrate 测试: 删 [测试A起, 下一个保留测试起)
  step(removeBetween(
    text,
    "  it('runs a complex sidecar Plan flow via orchestration', async () => {",
    "  it('uses Mastra sidecar execute directly in agent mode without generating a plan', async () => {",
    'spec/tests',
  ))

  if (ORCH.test(text)) {
    const left = text.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => ORCH.test(l))
    throw new Error(`spec 仍残留 ${left.length} 处:\n${left.map(([i, l]) => `  ${i}: ${l.trim()}`).join('\n')}`)
  }
  if (text !== original) writeFileSync(path, text, 'utf8')
  console.log(`[spec] 应用 ${n} 步，orchestrate 清零。`)
}

// ========== B) 两个 boundary.md(无关英文词改写) ==========
for (const [rel, from, to] of [
  ['src/components/workbench/sidebar/explorer/explorer.boundary.md',
   '- File/folder mutation orchestration', '- File/folder mutation coordination'],
  ['src/components/workbench/sidebar/ssh/ssh.boundary.md',
   '- Remote file preview dialog orchestration', '- Remote file preview dialog coordination'],
]) {
  const path = resolve(repoRoot, rel)
  let text = readFileSync(path, 'utf8')
  const original = text
  const r = replaceOnce(text, from, to, rel)
  text = r.text
  if (ORCH.test(text)) throw new Error(`${rel} 仍残留 orchestrate，请人工核对。`)
  if (text !== original) writeFileSync(path, text, 'utf8')
  console.log(`[${rel.split('/').pop()}] ${r.applied ? '已改写' : '已是目标态'}，orchestrate 清零。`)
}

console.log('\n[done] 3 文件已处理。请运行 node scripts/refactor/residual-orchestrate-gate.mjs 复核(应为 0)。')