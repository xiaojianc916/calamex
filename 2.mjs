// cleanup-rust-legacy-sidecar-contracts.mjs  （修正版）
// 删除 contracts/builtin_agent.rs 中前 ACP 时代的 sidecar 三件套契约残渣，
// 并改写 AgentExternalChatRequest 文档里对已删类型的悬空引用。
// 幂等：已清理后再跑会因锚点未命中而抛错（不写入半成品）。在仓库根目录运行。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const REL = 'src-tauri/src/commands/contracts/builtin_agent.rs'
const abs = join(ROOT, REL)
if (!existsSync(abs)) throw new Error('找不到目标文件：' + REL + '（请在仓库根目录运行）')

const detectEol = (t) => (t.includes('\r\n') ? '\r\n' : '\n')
const toLf = (s) => s.replace(/\r\n/g, '\n')
const fromLf = (s, eol) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s)

const rawText = readFileSync(abs, 'utf8')
const eol = detectEol(rawText)
let text = toLf(rawText)
const before = text.length

// 删除 [startNeedle, endNeedle) 区间，保留 endNeedle（即“从某条目头删到下一保留条目头”）。
function cutRange(startNeedle, endNeedle) {
	const s = text.indexOf(startNeedle)
	if (s < 0) throw new Error('未命中起始锚点：' + startNeedle.slice(0, 70))
	const e = text.indexOf(endNeedle, s)
	if (e < 0) throw new Error('未命中结束锚点：' + endNeedle.slice(0, 70))
	text = text.slice(0, s) + text.slice(e)
}

// 唯一性替换。
function replaceOnce(oldStr, newStr) {
	const i = text.indexOf(oldStr)
	if (i < 0) throw new Error('未命中替换锚点：' + oldStr.slice(0, 70))
	if (text.indexOf(oldStr, i + oldStr.length) >= 0)
		throw new Error('替换锚点不唯一：' + oldStr.slice(0, 70))
	text = text.slice(0, i) + newStr + text.slice(i + oldStr.length)
}

// 按花括号配对删除一个条目（可选前导锚点，如 '    #[test]\n'），并吞掉其后的空行。
// 注意：仅用于体内字符串不含裸 { } 的条目（本处被删测试均满足）。
function removeBraceItem(headNeedle, leadNeedle) {
	const h = text.indexOf(headNeedle)
	if (h < 0) throw new Error('未命中条目头：' + headNeedle)
	let start = h
	if (leadNeedle) {
		const l = text.lastIndexOf(leadNeedle, h)
		if (l < 0) throw new Error('未命中前导锚点：' + leadNeedle + ' @ ' + headNeedle)
		start = l
	}
	const open = text.indexOf('{', h)
	if (open < 0) throw new Error('未找到主体起始花括号：' + headNeedle)
	let depth = 0
	let i = open
	for (; i < text.length; i++) {
		const c = text[i]
		if (c === '{') depth++
		else if (c === '}') {
			depth--
			if (depth === 0) {
				i++
				break
			}
		}
	}
	if (depth !== 0) throw new Error('花括号不平衡：' + headNeedle)
	let end = i
	while (text[end] === '\n') end++
	text = text.slice(0, start) + text.slice(end)
}

// 1) 去掉因结构删除而未用的 import。
replaceOnce('use super::ai_chat::AiContextReferencePayload;\n', '')

// 2) AgentSidecarMessagePayload（删到 ModelConfigPayload 头）。
cutRange(
	`#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarMessagePayload {`,
	`#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarModelConfigPayload {`,
)

// 3) AgentSidecarWarmupRequest 兼容空壳（含 #[expect(dead_code)]，删到 is_blank 辅助函数头）。
cutRange(
	`#[expect(
    dead_code,`,
	`fn is_blank_optional_string(value: &Option<String>) -> bool {`,
)

// 4) Chat / ApprovalResolve / AskUserAnswer / AskUserResume 一整段（含文档注释，删到 RollbackStepPath 头）。
cutRange(
	`#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSidecarChatRequest {`,
	`#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum AgentSidecarRollbackStepPath {`,
)

// 4b) 改写 AgentExternalChatRequest 文档里对“已删类型”的悬空引用（散文层，非代码）。
replaceOnce(
	'/// 与自家 `AgentSidecarChatRequest` 不同：外部 agent 只实现标准 `prompt`、不认识',
	'/// 与自家边车的带外 `agent_chat` 扩展回合不同：外部 agent 只实现标准 `prompt`、不认识',
)

// 5) 收敛测试模块的 use 列表（只留仍被保留测试引用的类型）。
replaceOnce(
	`    use super::{
        AgentBackendKind, AgentExternalChatRequest, AgentSidecarAskUserAnswerPayload,
        AgentSidecarAskUserResumeRequest, AgentSidecarChatRequest,
        AgentSidecarCheckpointRestoreRequest, AgentSidecarMessagePayload,
        AgentSidecarRollbackStepPath,
    };`,
	`    use super::{
        AgentBackendKind, AgentExternalChatRequest, AgentSidecarCheckpointRestoreRequest,
        AgentSidecarRollbackStepPath,
    };`,
)

// 6) 删除仅服务于被删测试的辅助函数与 5 个测试。
removeBraceItem('    fn sidecar_message(')
removeBraceItem('    fn chat_request_omits_blank_optional_fields(', '    #[test]\n')
removeBraceItem('    fn chat_request_keeps_non_empty_thread_id(', '    #[test]\n')
removeBraceItem(
	'    fn ask_user_resume_request_omits_blank_optionals_and_serializes_answers(',
	'    #[test]\n',
)
removeBraceItem('    fn ask_user_resume_request_omits_answers_when_cancelled(', '    #[test]\n')
removeBraceItem(
	'    fn ask_user_answer_payload_emits_empty_option_ids_array_and_omits_blank_text(',
	'    #[test]\n',
)

// 护栏（按“定义形态”校验，避免散文提及误伤）：确认目标定义已彻底清除。
for (const gone of [
	'pub struct AgentSidecarChatRequest',
	'pub struct AgentSidecarApprovalResolveRequest',
	'pub struct AgentSidecarAskUserResumeRequest',
	'pub struct AgentSidecarAskUserAnswerPayload',
	'pub struct AgentSidecarMessagePayload',
	'pub struct AgentSidecarWarmupRequest',
	'use super::ai_chat::AiContextReferencePayload',
	'    fn sidecar_message(',
]) {
	if (text.includes(gone)) throw new Error('清理后仍残留定义：' + gone)
}
// 护栏：确认散文里对已删类型的悬空引用也已消除。
if (text.includes('`AgentSidecarChatRequest`'))
	throw new Error('文档注释仍引用已删除类型 AgentSidecarChatRequest')
// 护栏：确认应保留的关键条目仍在。
for (const keep of [
	'pub struct AgentSidecarModelConfigPayload',
	'fn is_blank_optional_string',
	'pub enum AgentSidecarRollbackStepPath',
	'pub struct AgentSidecarCheckpointRestoreRequest',
	'pub enum AgentBackendKind',
	'pub struct AgentExternalChatRequest',
	'fn serialize_object',
	'fn external_chat_request_omits_blank_session_and_serializes_present_session',
]) {
	if (!text.includes(keep)) throw new Error('误删了应保留条目：' + keep)
}

writeFileSync(abs, fromLf(text, eol), 'utf8')
console.log('✓ 已清理 ' + REL)
console.log('  字节数(LF计)：' + before + ' → ' + text.length + '（净减 ' + (before - text.length) + '）')
console.log('  下一步：cargo clippy --features acp_client --manifest-path src-tauri/Cargo.toml 应无未用 import/类型告警')