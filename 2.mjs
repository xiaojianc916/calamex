// scripts/refactor/b4-s3-builtin-acp-native.mjs
//
// B4 · S3 —— builtin 切入唯一标准 ACP 管线（session/prompt + set_session_mode）。
//
// 决策（你已确认）：统一 builtin 的 chat/agent/plan 三模式，全部经标准 ACP session/prompt
// 发送；模式经官方 set_session_mode 一次性切换（不入 prompt 负载）；legacy 分流全停用待 D1 删。
//
// 本脚本只改前端编排层 src/composables/ai/useAiAssistant.ts（按域、不碰面板/类型/后端）：
//   1) 新增 builtin 三模式 → ACP 模式 id 映射常量（chat→ask / agent→agent / plan→plan）。
//   2) executeExternalAgentRequest 增加可选 sessionMode 形参；builtin 在 prompt 前先
//      ensureAcpSession 建会话、再 set_session_mode 一次性切到目标模式（同一 thread 键，故被
//      本回合 prompt 复用），随后标准 session/prompt 按会话模式分流（见 builtin-agent agent.prompt）。
//   3) sendMessage：所有后端（builtin / Kimi / Codex）统一走 executeExternalAgentRequest；
//      删除 agent/plan/chat 三条 legacy 分支与穷举兜底，及仅 chat 用的 nextMessages 局部量。
//
// 先建后删（过渡期，符合「暂时无法编译可接受」）：executeSidecarAgentRequest / executeAiRequest
// 失去调用点后成为未使用函数（typecheck/lint 报 no-unused-vars），连同 finalizeSidecarTurn /
// applySidecarPatchSets / agentPlan.createPlan 等一并在 D1 删除，本步不动以防功能回退。
//
// 后端前置假设（运行前请确认其一已就绪）：宿主 ai_ensure_acp_session / ai_set_session_mode
// 能按 threadId 解析 builtin 后端会话（与 Kimi 同构）。S2 已把 builtin 收敛到同一
// ensure_session/new_session 路径，故按 thread 键解析应成立；若宿主未路由 builtin 这两个命令，
// 需在后端步补齐（属 host 路由，不在本前端脚本范围）。
//
// 用法：node scripts/refactor/b4-s3-builtin-acp-native.mjs   （不提交）

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const TARGET = 'src/composables/ai/useAiAssistant.ts';

function read(rel) {
  const abs = resolve(ROOT, rel);
  const raw = readFileSync(abs, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { abs, lf: raw.replace(/\r\n/g, '\n'), eol };
}

function write(abs, lfContent, eol) {
  const out = eol === '\r\n' ? lfContent.replace(/\n/g, '\r\n') : lfContent;
  writeFileSync(abs, out, 'utf8');
}

function replaceOnce(haystack, oldStr, newStr, label) {
  const i = haystack.indexOf(oldStr);
  if (i === -1) throw new Error('[S3] 锚点未命中: ' + label);
  if (haystack.indexOf(oldStr, i + oldStr.length) !== -1) {
    throw new Error('[S3] 锚点不唯一: ' + label);
  }
  return haystack.slice(0, i) + newStr + haystack.slice(i + oldStr.length);
}

const L = (lines) => lines.join('\n');

// ---------------------------------------------------------------------------
// Edit 1 —— 模式映射常量（插入到 SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT 之后）。
// ---------------------------------------------------------------------------
const EDIT1_OLD = 'const SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;';
const EDIT1_NEW = L([
  'const SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT = 12;',
  '',
  '// builtin 是标准 ACP 后端：前端三模式（chat/agent/plan）→ Agent 公示的 ACP 会话模式 id',
  '// （ask/plan/agent，见 builtin-agent AGENT_MODES / RUNTIME_METHOD_BY_MODE）。经官方',
  '// set_session_mode 一次性切换会话模式，绝不随 session/prompt 负载携带（IAgentExternalChatRequest',
  '// 无 mode 字段）。',
  'const BUILTIN_ACP_MODE_BY_ASSISTANT_MODE: Record<TAiAssistantMode, string> = {',
  "  chat: 'ask',",
  "  agent: 'agent',",
  "  plan: 'plan',",
  '};',
]);

// ---------------------------------------------------------------------------
// Edit 2 —— executeExternalAgentRequest 注释 + 形参（加 sessionMode）。
// ---------------------------------------------------------------------------
const EDIT2_OLD = L([
  '  // 外部 ACP 编码 agent（Kimi / Codex，ADR-0015）发送链路：经 builtin_agent_external_chat',
  '  // 驱动一轮标准 session/prompt。外部 agent 无富信封，过程增量经 session/update 帧走既有',
  '  // sidecar 流（subscribeSidecarSessionStream + applySidecarLiveEventsToAgentMessage）。',
  '  // 流式关键：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅，后端据此把外部帧的',
  '  // session_id 由 ACP 会话 UUID 重写为该键（见 Rust host.prompt_with_stream_key），实现逐',
  '  // token 实时渲染；prompt 返回即整轮结束，flush 后把消息状态收口为 completed。',
  '  const executeExternalAgentRequest = async (',
  '    backend: TAgentBackendKind,',
  '    messageContent: string,',
  '    threadId: string | null,',
  '  ): Promise<void> => {',
]);
const EDIT2_NEW = L([
  '  // 唯一标准发送链路（ADR-20260617）：所有 ACP 后端（builtin / Kimi / Codex）一律经',
  '  // builtin_agent_external_chat 驱动一轮标准 session/prompt。builtin 的 chat/plan/agent 三模式经',
  '  // 官方 set_session_mode 在发起回合前一次性切换（见下方 sessionMode 分支，映射 ask/plan/agent），',
  '  // 不再走自研边车的 mode 分流；Kimi / Codex 自管会话模式，不下发 sessionMode。过程增量经',
  '  // session/update 帧走既有 sidecar 流（subscribeSidecarSessionStream +',
  '  // applySidecarLiveEventsToAgentMessage）；工具审批 / 反向提问经 session/request_permission 由',
  '  // 面板级 useAcpApproval 闭环呈现，均不在本链路内联处理。',
  '  // 流式关键：用前端预生成的 sidecarSessionId 在发起回合「之前」订阅，后端据此把帧的 session_id',
  '  // 由 ACP 会话 UUID 重写为该键（见 Rust host.prompt_with_stream_key），实现逐 token 实时渲染；',
  '  // prompt 返回即整轮结束，flush 后把消息状态收口为 completed。',
  '  const executeExternalAgentRequest = async (',
  '    backend: TAgentBackendKind,',
  '    messageContent: string,',
  '    threadId: string | null,',
  '    sessionMode?: string,',
  '  ): Promise<void> => {',
]);

// ---------------------------------------------------------------------------
// Edit 3 —— prompt 前为 builtin 注入 ensureAcpSession + set_session_mode。
// ---------------------------------------------------------------------------
const EDIT3_OLD = L([
  '      await aiService.sidecarExternalChat({',
  '        backend,',
  '        text: messageContent,',
  '        sessionId: sidecarSessionId,',
  '        workspaceRootPath: options.workspaceRootPath.value,',
  '        ...(targetThreadId ? { threadId: targetThreadId } : {}),',
  '      });',
]);
const EDIT3_NEW = L([
  "      if (backend === 'builtin' && sessionMode !== undefined) {",
  '        // builtin 也是标准 ACP 后端：先确保会话建立（与本回合 prompt 同一 thread 键，故被 prompt',
  '        // 复用），再经官方 set_session_mode 把会话一次性切到目标模式；随后标准 session/prompt 即按',
  '        // 会话模式分流到 chat/plan/execute（见 builtin-agent CalamexAcpAgent.prompt）。',
  "        const sessionThreadId = targetThreadId ?? '';",
  '        await aiService.ensureAcpSession({',
  '          threadId: sessionThreadId,',
  '          backend,',
  '          workspaceRootPath: options.workspaceRootPath.value,',
  '        });',
  '        await aiService.setSessionMode({ threadId: sessionThreadId, modeId: sessionMode });',
  '      }',
  '',
  '      await aiService.sidecarExternalChat({',
  '        backend,',
  '        text: messageContent,',
  '        sessionId: sidecarSessionId,',
  '        workspaceRootPath: options.workspaceRootPath.value,',
  '        ...(targetThreadId ? { threadId: targetThreadId } : {}),',
  '      });',
]);

// ---------------------------------------------------------------------------
// Edit 4 —— sendMessage 路由收敛为唯一标准管线（删 nextMessages + 三条 legacy 分支 + 穷举兜底）。
// ---------------------------------------------------------------------------
const EDIT4_OLD = L([
  '    const nextMessages = unref(conversationStore.activeMessages);',
  '',
  '    // 外部 ACP 编码 agent（Kimi / Codex）走独立发送链路，与 activeMode（chat/agent/plan）无关：',
  '    // 外部 agent 自管会话与运行循环，不复用自研边车的 mode 分流。',
  '    const externalBackend = sendOptions?.agentBackend;',
  "    if (externalBackend && externalBackend !== 'builtin') {",
  '      await executeExternalAgentRequest(externalBackend, messageContent, titleThreadId);',
  '',
  '      if (!errorMessage.value) {',
  '        void maybeGenerateConversationTitle(titleThreadId);',
  '      }',
  '',
  '      return;',
  '    }',
  '',
  "    if (activeMode.value === 'agent') {",
  '      await executeSidecarAgentRequest(messageContent, references, userMessage.id, titleThreadId);',
  '',
  '      if (!errorMessage.value) {',
  '        void maybeGenerateConversationTitle(titleThreadId);',
  '      }',
  '',
  '      return;',
  '    }',
  '',
  "    if (activeMode.value === 'plan') {",
  '      agentSteps.value = [];',
  '      let planSucceeded = false;',
  '',
  '      try {',
  '        const planResult = await agentPlan.createPlan(',
  '          messageContent,',
  '          buildSidecarContextReferences(references),',
  '          options.workspaceRootPath.value,',
  '          titleThreadId ? { threadId: titleThreadId } : {},',
  '        );',
  '',
  '        agentSteps.value = planResult.steps.map((step) => ({',
  '          id: step.id,',
  '          title: step.title,',
  '          status: step.status,',
  '        }));',
  '',
  '        clearAttachedFiles({ revokePreviews: false });',
  '        planSucceeded = true;',
  '      } catch (error) {',
  "        const message = toErrorMessage(error, '生成计划失败。');",
  '        errorMessage.value = message;',
  '        agentSteps.value = [];',
  '        aiThreadStore.patchActiveThreadEntries((entries) => [',
  '          ...entries,',
  '          ...legacyMessageToEntries({',
  "            id: createMessageId('assistant'),",
  "            role: 'assistant',",
  '            content: `计划生成失败：${message}`,',
  '            createdAt: new Date().toISOString(),',
  '            references: [],',
  '          }),',
  '        ]);',
  '      } finally {',
  '        clearActiveBufferedThread(titleThreadId);',
  '        isSending.value = false;',
  '        if (planSucceeded) {',
  '          void maybeGenerateConversationTitle(titleThreadId);',
  '        }',
  '      }',
  '',
  '      return;',
  '    }',
  "    if (activeMode.value === 'chat') {",
  '      try {',
  '        await executeAiRequest(nextMessages, references, titleThreadId);',
  '        if (!errorMessage.value) {',
  '          void maybeGenerateConversationTitle(titleThreadId);',
  '        }',
  '      } catch (error) {',
  '        errorMessage.value = toErrorMessage(error, MSG_CALL_FAILED);',
  '      }',
  '      return;',
  '    }',
  '',
  '    const exhaustiveModeCheck: never = activeMode.value;',
  '    throw new Error(`未处理的 AI 助手模式：${String(exhaustiveModeCheck)}`);',
]);
const EDIT4_NEW = L([
  '    // 唯一标准管线（ADR-20260617）：所有后端（builtin / Kimi / Codex）一律经标准 ACP',
  '    // session/prompt 发送。builtin 的 chat/agent/plan 三模式经官方 set_session_mode 一次性切换',
  '    // （见 executeExternalAgentRequest 的 sessionMode 分支，映射 ask/plan/agent）；Kimi / Codex',
  '    // 自管会话模式，故不下发 sessionMode。legacy 分流（executeSidecarAgentRequest /',
  '    // agentPlan.createPlan / executeAiRequest）已停用，随 D1 删除（先建后删，过渡期保留以防回退）。',
  "    const backend: TAgentBackendKind = sendOptions?.agentBackend ?? 'builtin';",
  '    const sessionMode =',
  "      backend === 'builtin' ? BUILTIN_ACP_MODE_BY_ASSISTANT_MODE[activeMode.value] : undefined;",
  '',
  '    await executeExternalAgentRequest(backend, messageContent, titleThreadId, sessionMode);',
  '',
  '    if (!errorMessage.value) {',
  '      void maybeGenerateConversationTitle(titleThreadId);',
  '    }',
]);

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
const { abs, lf, eol } = read(TARGET);
let next = lf;
next = replaceOnce(next, EDIT1_OLD, EDIT1_NEW, 'Edit1: mode map const');
next = replaceOnce(next, EDIT2_OLD, EDIT2_NEW, 'Edit2: executeExternalAgentRequest signature');
next = replaceOnce(next, EDIT3_OLD, EDIT3_NEW, 'Edit3: ensureAcpSession + setSessionMode');
next = replaceOnce(next, EDIT4_OLD, EDIT4_NEW, 'Edit4: sendMessage unified routing');
write(abs, next, eol);

console.log('[S3] 已更新 ' + TARGET + '（EOL=' + (eol === '\r\n' ? 'CRLF' : 'LF') + '）');
console.log('[S3] builtin 已切入唯一标准 ACP 管线；legacy 分流停用待 D1 删除（过渡期 typecheck 会报未使用函数，符合预期）。');