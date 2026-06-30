// 1.mjs — ① 唯一标准管线：所有 ACP 后端发起回合前统一建立会话
// 修复「Kimi 切换模型空操作」：Kimi 之前从不 ensureAcpSession，thread 未绑定 →
// host.set_session_config_option 命中不到会话、静默 Ok(false)。
// 用法：在工程根 D:\com.xiaojianc\my_desktop_app 执行 `node 1.mjs`，随后 pnpm typecheck && pnpm test
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const t = (...lines) => lines.join('\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');

function replaceOnce(src, find, repl, label) {
  const idx = src.indexOf(find);
  if (idx === -1) throw new Error(`[锚点未找到] ${label}`);
  if (src.indexOf(find, idx + find.length) !== -1) throw new Error(`[锚点不唯一] ${label}`);
  return src.slice(0, idx) + repl + src.slice(idx + find.length);
}

function edit(relPath, editList) {
  const abs = resolve(ROOT, relPath);
  let content = toLf(readFileSync(abs, 'utf8'));
  for (const [find, repl, label] of editList) content = replaceOnce(content, find, repl, label);
  writeFileSync(abs, content, 'utf8');
  console.log(`[ok] ${relPath}`);
}

// ---------- 1) src/composables/ai/useAiAssistant.ts ----------
const assistantFind = t(
  "      if (backend === 'builtin' && modeConfigValue !== undefined) {",
  '        // builtin 也是标准 ACP 后端：先确保会话建立（与本回合 prompt 同一 thread 键，故被 prompt',
  '        // 复用），再经官方 set_config_option（configId=mode）把会话一次性切到目标模式取值；随后标准',
  '        // session/prompt 即按会话模式分流到 chat/plan/execute（见 builtin-agent CalamexAcpAgent.prompt）。',
  "        const sessionThreadId = targetThreadId ?? '';",
  '        await aiService.ensureAcpSession({',
  '          threadId: sessionThreadId,',
  '          backend,',
  '          workspaceRootPath: options.workspaceRootPath.value,',
  '        });',
  '        await aiService.setSessionConfigOption({',
  '          threadId: sessionThreadId,',
  '          configId: MODE_CONFIG_OPTION_ID,',
  '          valueId: modeConfigValue,',
  '        });',
  '      }',
);
const assistantRepl = t(
  '      // 唯一标准管线（ADR-20260617）：所有 ACP 后端（builtin / Kimi / Codex）在发起回合「之前」一律',
  '      // 确保会话建立，把 thread_id 绑定到宿主会话——使后续 set_config_option 命中既有会话（未绑定时',
  '      // 宿主 set_session_config_option 会静默空操作 Ok(false)），并让 agent（如 Kimi）在 session/new 后',
  '      // 下发的一次性 config_option_update 有稳定会话可挂靠。builtin 额外经官方 set_config_option',
  '      // （configId=mode）一次性切到目标模式取值（映射 ask/plan/agent）；Kimi / Codex 自管会话模式，',
  '      // 不下发模式取值。随后标准 session/prompt 按会话模式分流（见 builtin-agent CalamexAcpAgent.prompt）。',
  "      const sessionThreadId = targetThreadId ?? '';",
  '      await aiService.ensureAcpSession({',
  '        threadId: sessionThreadId,',
  '        backend,',
  '        workspaceRootPath: options.workspaceRootPath.value,',
  '      });',
  "      if (backend === 'builtin' && modeConfigValue !== undefined) {",
  '        await aiService.setSessionConfigOption({',
  '          threadId: sessionThreadId,',
  '          configId: MODE_CONFIG_OPTION_ID,',
  '          valueId: modeConfigValue,',
  '        });',
  '      }',
);
edit('src/composables/ai/useAiAssistant.ts', [
  [assistantFind, assistantRepl, 'useAiAssistant: 统一所有后端发起回合前建立会话'],
]);

// ---------- 2) src/composables/ai/useAiAssistant.spec.ts ----------
const specFind = t(
  "  it('外部 Kimi 后端不下发模式取值，直接 session/prompt', async () => {",
  '    const assistant = createAssistantHarness();',
  '',
  "    assistant.activeMode.value = 'chat';",
  "    assistant.draft.value = '用 Kimi 跑一轮';",
  "    await assistant.sendMessage({ agentBackend: 'kimi' });",
  '',
  '    expect(aiServiceMock.ensureAcpSession).not.toHaveBeenCalled();',
  '    expect(aiServiceMock.setSessionConfigOption).not.toHaveBeenCalled();',
  '    expect(aiServiceMock.sidecarExternalChat).toHaveBeenCalledWith(',
  "      expect.objectContaining({ backend: 'kimi', text: '用 Kimi 跑一轮' }),",
  '    );',
  '  });',
);
const specRepl = t(
  "  it('外部 Kimi 后端建立会话但不下发模式取值，直接 session/prompt', async () => {",
  '    const assistant = createAssistantHarness();',
  '',
  "    assistant.activeMode.value = 'chat';",
  "    assistant.draft.value = '用 Kimi 跑一轮';",
  "    await assistant.sendMessage({ agentBackend: 'kimi' });",
  '',
  '    // 唯一标准管线：所有后端发起回合前均建立会话（绑定 thread↔会话，使配置项切换命中既有会话）；',
  '    // 但 Kimi / Codex 自管会话模式，不经 set_config_option 下发 mode 取值。',
  '    expect(aiServiceMock.ensureAcpSession).toHaveBeenCalledWith(',
  "      expect.objectContaining({ backend: 'kimi' }),",
  '    );',
  '    expect(aiServiceMock.setSessionConfigOption).not.toHaveBeenCalled();',
  '    expect(aiServiceMock.sidecarExternalChat).toHaveBeenCalledWith(',
  "      expect.objectContaining({ backend: 'kimi', text: '用 Kimi 跑一轮' }),",
  '    );',
  '  });',
);
edit('src/composables/ai/useAiAssistant.spec.ts', [
  [specFind, specRepl, 'spec: Kimi 现在也建立会话'],
]);

console.log('完成。请运行：pnpm typecheck && pnpm test');