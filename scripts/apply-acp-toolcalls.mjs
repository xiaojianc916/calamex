#!/usr/bin/env node
// scripts/apply-acp-toolcalls.mjs
//
// 用途：把 ACP tool-call 投影接入 useAiAssistant.ts 的 6 处改动（4c-b）。
//   1) import reduceAcpUiEventsToToolCalls
//   2) IUpdateAgentExecutionMessageInput 增加 acpToolCalls 字段
//   3) updateAgentExecutionMessage 解构增加 acpToolCalls
//   4) updateAgentExecutionMessage 返回对象增加 ...(acpToolCalls?.length ? { acpToolCalls } : {})
//   5) applySidecarLiveEventsToAgentMessage 调用处增加 acpToolCalls: reduceAcpUiEventsToToolCalls(events)
//   6) finalizeSidecarTurn 调用处增加 acpToolCalls: reduceAcpUiEventsToToolCalls(payload.events)
//
// 特性：幂等（已应用则跳过）、全有或全无（任一锚点缺失则整体不写盘）。
// 运行：node scripts/apply-acp-toolcalls.mjs [可选: 文件路径] [--dry]
//   不传路径时在 src/ 下按文件名自动查找；--dry 仅预览不写盘。

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
let file = args.find((a) => !a.startsWith('--'))

const NEW_IMPORT = `import { reduceAcpUiEventsToToolCalls } from '@/components/business/ai/thread/projection';`

const FN_NAMES = [
	'applySidecarLiveEventsToAgentMessage',
	'finalizeSidecarTurn',
	'updateAgentExecutionMessage',
	'executeAiRequest',
	'executeSidecarAgentRequest',
	'resolveSidecarToolConfirmation',
	'resolveSidecarUserQuestion',
]

// ---------- locate file ----------
function findFile(root, name) {
	const out = []
	const walk = (dir) => {
		let entries
		try {
			entries = readdirSync(dir)
		} catch {
			return
		}
		for (const e of entries) {
			if (['node_modules', '.git', 'dist', 'target', '.output'].includes(e)) continue
			const p = join(dir, e)
			let s
			try {
				s = statSync(p)
			} catch {
				continue
			}
			if (s.isDirectory()) walk(p)
			else if (e === name) out.push(p)
		}
	}
	walk(root)
	return out
}

if (!file) {
	const hits = findFile(resolve('src'), 'useAiAssistant.ts')
	if (hits.length === 0) {
		console.error('❌ 找不到 useAiAssistant.ts，请显式传入路径。')
		process.exit(1)
	}
	if (hits.length > 1) {
		console.error('❌ 找到多个 useAiAssistant.ts，请显式传入路径：\n' + hits.join('\n'))
		process.exit(1)
	}
	file = hits[0]
}
file = resolve(file)
const src = readFileSync(file, 'utf8')

// ---------- helpers ----------
function lineAt(s, idx) {
	const lineStart = s.lastIndexOf('\n', idx - 1) + 1
	let lineEnd = s.indexOf('\n', idx)
	if (lineEnd === -1) lineEnd = s.length
	const lineText = s.slice(lineStart, lineEnd)
	const indent = (lineText.match(/^[ \t]*/) || [''])[0]
	return { lineStart, lineEnd, lineText, indent }
}
function nextLineTrim(s, lineEnd) {
	const m = /^\n([ \t]*)([^\n]*)/.exec(s.slice(lineEnd))
	return m ? m[2].trim() : ''
}
function findDef(name) {
	const re = new RegExp(`(?:const|let)\\s+${name}\\s*=|function\\s+${name}\\b`, 'g')
	const m = re.exec(src)
	return m ? m.index : -1
}
function boundaryAfter(start, names) {
	let end = src.length
	for (const name of names) {
		const re = new RegExp(`(?:const|let)\\s+${name}\\s*=|function\\s+${name}\\b`, 'g')
		re.lastIndex = start + 1
		const m = re.exec(src)
		if (m && m.index < end) end = m.index
	}
	return end
}

const edits = []
const errors = []

// 在 src 中、从 searchFrom 起，匹配 lineRegex（first/last），在该行后插入 core
function planInsertAfterLine({ label, searchFrom = 0, end = src.length, lineRegex, core, occurrence = 'first' }) {
	const flags = lineRegex.flags.includes('g') ? lineRegex.flags : lineRegex.flags + 'g'
	const re = new RegExp(lineRegex.source, flags)
	re.lastIndex = searchFrom
	let m
	let chosen = null
	while ((m = re.exec(src))) {
		if (m.index >= end) break
		chosen = m
		if (occurrence === 'first') break
	}
	if (!chosen) {
		errors.push(`[${label}] 未找到目标行：${lineRegex}`)
		return
	}
	const { lineEnd, indent } = lineAt(src, chosen.index)
	if (nextLineTrim(src, lineEnd) === core.trim()) {
		console.log(`· [${label}] 已存在，跳过`)
		return
	}
	edits.push({ label, pos: lineEnd, text: `\n${indent}${core}` })
}

// ---------- 1) import ----------
planInsertAfterLine({
	label: '1/import',
	lineRegex: /^.*@\/components\/business\/ai\/edit\/patch-summary.*$/m,
	core: NEW_IMPORT,
})

// ---------- 2) interface 字段 ----------
{
	const m = /interface\s+IUpdateAgentExecutionMessageInput/.exec(src)
	if (!m) errors.push('[2/interface] 未找到 IUpdateAgentExecutionMessageInput')
	else
		planInsertAfterLine({
			label: '2/interface',
			searchFrom: m.index,
			lineRegex: /^[ \t]*toolCalls\?:[^\n]*$/m,
			core: `acpToolCalls?: IAiChatMessage['acpToolCalls'];`,
		})
}

// ---------- 3) + 4) updateAgentExecutionMessage ----------
{
	const start = findDef('updateAgentExecutionMessage')
	if (start < 0) errors.push('[3/4] 未找到 updateAgentExecutionMessage 定义')
	else {
		const end = boundaryAfter(
			start,
			FN_NAMES.filter((n) => n !== 'updateAgentExecutionMessage'),
		)
		// 3) 解构默认值 toolCalls = [],
		planInsertAfterLine({
			label: '3/destructure',
			searchFrom: start,
			end,
			lineRegex: /^[ \t]*toolCalls = \[\],[^\n]*$/m,
			core: `acpToolCalls,`,
		})
		// 4) 返回对象里的 stream,（取区域内最后一处 stream，避开解构里的 stream）
		planInsertAfterLine({
			label: '4/return',
			searchFrom: start,
			end,
			lineRegex: /^[ \t]*stream,[ \t]*$/m,
			core: `...(acpToolCalls?.length ? { acpToolCalls } : {}),`,
			occurrence: 'last',
		})
	}
}

// ---------- 5) applySidecarLiveEventsToAgentMessage ----------
{
	const start = findDef('applySidecarLiveEventsToAgentMessage')
	if (start < 0) errors.push('[5/apply] 未找到 applySidecarLiveEventsToAgentMessage 定义')
	else
		planInsertAfterLine({
			label: '5/apply',
			searchFrom: start,
			lineRegex: /^[ \t]*toolCalls: toolProjection\.toolCalls,[ \t]*$/m,
			core: `acpToolCalls: reduceAcpUiEventsToToolCalls(events),`,
		})
}

// ---------- 6) finalizeSidecarTurn ----------
{
	const start = findDef('finalizeSidecarTurn')
	if (start < 0) errors.push('[6/finalize] 未找到 finalizeSidecarTurn 定义')
	else
		planInsertAfterLine({
			label: '6/finalize',
			searchFrom: start,
			lineRegex: /^[ \t]*toolCalls: toolProjection\.toolCalls,[ \t]*$/m,
			core: `acpToolCalls: reduceAcpUiEventsToToolCalls(payload.events),`,
		})
}

// ---------- 校验 ----------
if (errors.length) {
	console.error('\n❌ 失败，未写入任何改动：')
	for (const e of errors) console.error('   - ' + e)
	console.error('\n把对应锚点附近的真实代码贴给我，我再调脚本。')
	process.exit(1)
}
// 碰撞检测：两处插入落到同一行尾说明锚点串了
const posSet = new Set()
for (const e of edits) {
	if (posSet.has(e.pos)) {
		console.error(`❌ 检测到插入位置冲突（${e.label}），疑似锚点定位串行，已中止。`)
		process.exit(1)
	}
	posSet.add(e.pos)
}
if (edits.length === 0) {
	console.log('\n✅ 6 处改动均已存在，无需修改。')
	process.exit(0)
}

// ---------- 应用（从后往前，避免位移失效）----------
edits.sort((a, b) => b.pos - a.pos)
let out = src
for (const e of edits) {
	out = out.slice(0, e.pos) + e.text + out.slice(e.pos)
	console.log(`✎ ${DRY ? '[dry] ' : ''}应用 ${e.label}: ${e.text.trim()}`)
}

if (DRY) {
	console.log('\n（--dry）未写盘。去掉 --dry 即可应用。')
	process.exit(0)
}
writeFileSync(file, out, 'utf8')
console.log(`\n✅ 已写入 ${file}（${edits.length} 处改动）。`)
console.log('   接着跑：pnpm test from-acp && pnpm typecheck')