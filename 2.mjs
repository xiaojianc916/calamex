#!/usr/bin/env node
// 清理 src-tauri/src/acp/host.rs 中对「已删除」的 orchestrate / orchestrate_resume
// 扩展方法的陈旧注释引用（命中残留门禁 /orchestrat(?!or)/i）。
// 原则：仅改注释，不动逻辑；中文「编排」不被门禁正则命中，保持不动。
// 幂等：每条替换要求恰好命中一次；已是目标态则跳过；命中多次则报错。终态硬校验在写文件之前。
// 用法：在仓库根目录执行 node <此文件>

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = process.cwd()
const targetPath = resolve(repoRoot, 'src-tauri/src/acp/host.rs')

/** @type {Array<{ from: string; to: string }>} */
const replacements = [
  {
    from: '//!     warmup / health / orchestrate / orchestrate_resume / agent_chat /',
    to: '//!     warmup / health / agent_chat /',
  },
  {
    from: '//!   * **编排/对话即带外**：`orchestrate` / `orchestrate_resume` / `agent_chat` /',
    to: '//!   * **对话即带外**：`agent_chat` /',
  },
  {
    from: '//!     单点负责（见 `ui_event`），本层不投影。权威结果由各扩展方法（agent_chat /',
    to: '//!     单点负责（见 `ui_event`），本层不投影。权威结果由各扩展方法（agent_chat',
  },
  {
    from: '//!     orchestrate 等）的返回信封承载。',
    to: '//!     等）的返回信封承载。',
  },
  // prompt() docstring：去掉「/ `orchestrate`」
  {
    from: '    /// 与带外的 `agent_chat` / `orchestrate`（自家 sidecar 扩展方法）不同，本方法走的是',
    to: '    /// 与带外的 `agent_chat`（自家 sidecar 扩展方法）不同，本方法走的是',
  },
  // agent_chat() docstring：「同 `orchestrate` 不在此累积回合」→「本方法 不在此累积回合」
  {
    from: '    /// 的富事件（结构化补丁/检查点/回滚/富审批/plan_ready 等）由返回信封承载。同',
    to: '    /// 的富事件（结构化补丁/检查点/回滚/富审批/plan_ready 等）由返回信封承载。本方法',
  },
  {
    from: '    /// `orchestrate` 不在此累积回合，帧仅经 `EventSink` 转发 webview。入参为已构造的',
    to: '    /// 不在此累积回合，帧仅经 `EventSink` 转发 webview。入参为已构造的',
  },
]

const original = readFileSync(targetPath, 'utf8')
let next = original
let applied = 0
let skipped = 0

for (const { from, to } of replacements) {
  const count = next.split(from).length - 1
  if (count === 0) {
    if (next.includes(to)) {
      skipped += 1
      continue
    }
    throw new Error(`未命中且无目标态，疑似源码已漂移，请人工核对：\n  ${from}`)
  }
  if (count > 1) {
    throw new Error(`命中 ${count} 次（要求唯一），拒绝模糊替换：\n  ${from}`)
  }
  next = next.replace(from, to)
  applied += 1
}

const stale = next.match(/orchestrat(?!or)/gi)
if (stale) {
  throw new Error(`host.rs 仍残留 ${stale.length} 处 orchestrate 引用，请人工核对。`)
}

if (next === original) {
  console.log('[p5c-host] 无改动：已是目标态。')
} else {
  writeFileSync(targetPath, next, 'utf8')
  console.log(`[p5c-host] 已更新 ${targetPath}`)
}
console.log(`[p5c-host] 应用 ${applied} 处，跳过 ${skipped} 处，残留校验通过。`)