// d1s4a-builtin-agent-tripiece.mjs
// D1 Slice 4-A：删除 builtin-agent 侧「三件套」ext-method 包装（agent/chat、
// agent/chat/resolve、agent/ask-user/resume）。保留原生 prompt() 审批/提问环依赖的
// runtime.chat / resolveApproval / resolveAskUser 与 approval-bridge / ask-user-bridge。
// 验证：cd builtin-agent && pnpm typecheck && pnpm vitest run
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = process.cwd()
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n')
const toLf = (s) => s.split('\r\n').join('\n')
const fromLf = (s, eol) => (eol === '\r\n' ? s.split('\n').join('\r\n') : s)

const replaceOnce = (text, oldStr, newStr, label) => {
  const i = text.indexOf(oldStr)
  if (i === -1) throw new Error(`[${label}] 锚点未命中: ${oldStr.slice(0, 70)}`)
  if (text.indexOf(oldStr, i + oldStr.length) !== -1)
    throw new Error(`[${label}] 锚点多次命中: ${oldStr.slice(0, 70)}`)
  return text.slice(0, i) + newStr + text.slice(i + oldStr.length)
}

// 保留 startMarker 与 endMarker，删除两者之间的内容，用 joiner 衔接。
const removeBetween = (text, startMarker, endMarker, joiner, label) => {
  const s = text.indexOf(startMarker)
  if (s === -1) throw new Error(`[${label}] start 未命中: ${startMarker.slice(0, 60)}`)
  const sEnd = s + startMarker.length
  const e = text.indexOf(endMarker, sEnd)
  if (e === -1) throw new Error(`[${label}] end 未命中: ${endMarker.slice(0, 60)}`)
  if (text.indexOf(startMarker, sEnd) !== -1)
    throw new Error(`[${label}] start 多次命中`)
  return text.slice(0, sEnd) + joiner + text.slice(e)
}

const edit = (rel, fn) => {
  const abs = `${ROOT}/${rel}`
  const raw = readFileSync(abs, 'utf8')
  const eol = detectEol(raw)
  const next = fn(toLf(raw))
  writeFileSync(abs, fromLf(next, eol), 'utf8')
  console.log(`✓ ${rel}`)
}

// ── 1) agent.ts ───────────────────────────────────────────────
edit('builtin-agent/src/acp/agent.ts', (t) => {
  // 1a. 删除三个 handler 方法（含各自 JSDoc），保留 handleModelChat 与 handleWarmup。
  t = removeBetween(
    t,
    '\t\treturn toModelChatExtResult(response)\n\t}',
    '\t/**\n\t * 受理 LLM 连接预热扩展方法。',
    '\n\n',
    'agent.ts/handlers',
  )

  // 1b. 删除 extMethod switch 里三个 case 分支。
  t = replaceOnce(
    t,
    '\t\t\tcase AGENT_CHAT_METHOD:\n' +
      '\t\t\t\treturn this.handleAgentChat(params)\n' +
      '\t\t\tcase AGENT_CHAT_RESOLVE_METHOD:\n' +
      '\t\t\t\treturn this.handleAgentChatResolve(params)\n' +
      '\t\t\tcase AGENT_ASK_USER_RESUME_METHOD:\n' +
      '\t\t\t\treturn this.handleAgentAskUserResume(params)\n',
    '',
    'agent.ts/switch',
  )

  // 1c. 删除从 ext-methods.js 引入的 8 个三件套符号。
  for (const name of [
    'AGENT_ASK_USER_RESUME_METHOD',
    'AGENT_CHAT_METHOD',
    'AGENT_CHAT_RESOLVE_METHOD',
    'parseAgentAskUserResumeParams',
    'parseAgentChatParams',
    'parseAgentChatResolveParams',
    'toAgentAskUserResumeExtResult',
    'toAgentChatExtResult',
  ]) {
    t = replaceOnce(t, `\t${name},\n`, '', `agent.ts/import:${name}`)
  }
  return t
})

// ── 2) ext-methods.ts ─────────────────────────────────────────
edit('builtin-agent/src/acp/ext-methods.ts', (t) => {
  // 2a. 删除三个方法名常量及其 JSDoc（保留 HEALTH_METHOD 与 SIDECAR 段）。
  t = removeBetween(
    t,
    'export const HEALTH_METHOD = `${CALAMEX_EXT_NAMESPACE}/health`',
    '/**\n * sidecar 构建身份版本号',
    '\n\n',
    'ext.ts/consts',
  )

  // 2b. 从能力公示 extMethods 里删除三件套三键。
  t = replaceOnce(
    t,
    '\t\t\tagentChat: AGENT_CHAT_METHOD,\n' +
      '\t\t\tagentChatResolve: AGENT_CHAT_RESOLVE_METHOD,\n' +
      '\t\t\tagentAskUserResume: AGENT_ASK_USER_RESUME_METHOD,\n',
    '',
    'ext.ts/meta',
  )

  // 2c. 删除全部 agent-chat / ask_user 的 schema + parse + 投影函数
  //     （保留 toModelChatExtResult 与 toWarmupExtResult）。
  t = removeBetween(
    t,
    'export const toModelChatExtResult = (\n' +
      '\tresponse: IAgentRuntimeResponse,\n' +
      '): TAgentSidecarResponse => toAgentSidecarResponse(response)',
    '/** 预热结果投影：IWarmupResult',
    '\n\n',
    'ext.ts/schemas',
  )

  // 2d. 删除随之失效的两个类型 import（保留 IAgentMessageInput / IAgentRuntimeInput /
  //     ICheckpointRestoreInput，它们仍被 modelChat / checkpoint 路径使用）。
  t = replaceOnce(t, '\tIApprovalResolutionInput,\n', '', 'ext.ts/type:approval')
  t = replaceOnce(t, '\tIAskUserResolutionInput,\n', '', 'ext.ts/type:askuser')
  return t
})

console.log('done: D1 Slice 4-A (builtin-agent tri-piece removed)')