#!/usr/bin/env node
// scripts/acp-usage-token-context-tests.mjs
// D7-⑦ 接收侧用量消费：补齐 AiAssistantPanel.tokenOfficialUsage 优先采用 ACP usage 的测试，
// 并把 useAiAssistant mock 补成与真实公共表面一致（acpSessionModes/acpAvailableCommands/acpUsage）。
// 同时幂等兜底重放 .vue 的 ACP-usage 接线（marker 命中即跳过）。纯 ASCII 锚点；单文件单 marker。
// 运行：node scripts/acp-usage-token-context-tests.mjs
import { readFileSync, writeFileSync } from 'node:fs';

function patchFile(file, marker, edits) {
  const raw = readFileSync(file, 'utf8');
  if (raw.includes(marker)) {
    console.log(`[skip] ${file} 已打过补丁`);
    return;
  }
  const hadCrlf = raw.includes('\r\n');
  let text = hadCrlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const [anchor, replacement, keyword] of edits) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      const ctx = text
        .split('\n')
        .filter((line) => line.includes(keyword))
        .slice(0, 8)
        .join('\n');
      throw new Error(
        `[${file}] anchor "${keyword}": expected 1 match but found ${count}\n--- context ---\n${ctx}`,
      );
    }
    text = text.replace(anchor, () => replacement);
  }
  const out = hadCrlf ? text.replace(/\n/g, '\r\n') : text;
  writeFileSync(file, out, 'utf8');
  console.log(`[ok] ${file} patched`);
}

// ---------------------------------------------------------------------------
// 1) AiAssistantPanel.vue —— 幂等兜底重放 tokenOfficialUsage 的 ACP usage 接线
// ---------------------------------------------------------------------------
const VUE = 'src/components/business/ai/shell/AiAssistantPanel.vue';
patchFile(VUE, 'const acpTurnUsage = assistant.acpUsage.usage.value;', [
  [
    `const tokenOfficialUsage = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  return planStore.value.totalOfficialUsageResolved ? planStore.value.totalOfficialUsage : null;
});`,
    `const tokenOfficialUsage = computed(() => {
  // 接收侧 ACP usage_update 闭环（ADR-20260617 · D7-⑦）：宿主已把 usage_update 投影为
  // 共享 IAiLanguageModelUsage VM。任一模式只要本回合有 ACP 用量就优先采用（chat / agent
  // 经 ACP host 上报）；其形状与外部 LanguageModelUsage 赋值兼容，可直接作为官方用量来源。
  const acpTurnUsage = assistant.acpUsage.usage.value;
  if (acpTurnUsage) {
    return acpTurnUsage;
  }

  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  return planStore.value.totalOfficialUsageResolved ? planStore.value.totalOfficialUsage : null;
});`,
    'tokenOfficialUsage',
  ],
]);

// ---------------------------------------------------------------------------
// 2) AiAssistantPanel.spec.ts —— mock 补三件套 + 放开 officialUsage 捕获类型 + 两条用例
// ---------------------------------------------------------------------------
const SPEC = 'src/components/business/ai/shell/AiAssistantPanel.spec.ts';
patchFile(SPEC, 'prefers ACP usage_update over plan-store usage', [
  // 2a. 导入 IAiLanguageModelUsage（保持 import 列表字母序）
  [
    `  IAiContextReference,
  IAiTaskPlanStep,`,
    `  IAiContextReference,
  IAiLanguageModelUsage,
  IAiTaskPlanStep,`,
    'IAiContextReference',
  ],
  // 2b. 放开 token-context 捕获结构，纳入 officialUsage
  [
    `interface ITokenContextArgs {
  messages: { value: IAiChatMessage[] };
  estimationMessages: { value: IAiChatMessage[] };
}`,
    `interface ITokenContextArgs {
  messages: { value: IAiChatMessage[] };
  estimationMessages: { value: IAiChatMessage[] };
  officialUsage?: { value: IAiLanguageModelUsage | null | undefined };
}`,
    'interface ITokenContextArgs',
  ],
  // 2c. 声明可控的 ACP usage ref
  [
    `  const agentPlanStore = {`,
    `  const acpUsageRef = ref<IAiLanguageModelUsage | null>(null);

  const agentPlanStore = {`,
    'const agentPlanStore =',
  ],
  // 2d. 把三件套补进 mock 的公共表面（与真实 useAiAssistant 返回同构）
  [
    `  return {
    config,
    messages,
    historyThreads,`,
    `  return {
    acpSessionModes: {
      state: computed(() => null),
      availableModes: computed(() => []),
      currentMode: computed(() => null),
      hasModes: computed(() => false),
      isSwitching: computed(() => false),
      loadModes: vi.fn().mockResolvedValue(undefined),
      selectMode: vi.fn().mockResolvedValue(undefined),
      applyModeUpdate: vi.fn(),
      reset: vi.fn(),
    },
    acpAvailableCommands: {
      state: computed(() => null),
      commands: computed(() => []),
      hasCommands: computed(() => false),
      applyCommandsUpdate: vi.fn(),
      reset: vi.fn(),
    },
    acpUsage: {
      usage: acpUsageRef,
      hasUsage: computed(() => acpUsageRef.value !== null),
      applyUsageUpdate: vi.fn(),
      reset: vi.fn(),
    },
    config,
    messages,
    historyThreads,`,
    'return {',
  ],
  // 2e. 两条用例：ACP 用量优先；两端皆空时无官方用量
  [
    `    expect(assistantMock.sendMessage).toHaveBeenCalledTimes(1);
  });
});`,
    `    expect(assistantMock.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('prefers ACP usage_update over plan-store usage for the token context (chat mode)', () => {
    const assistantMock = createAssistantMock([createMessage('message-user', 'user', 'hi')]);
    assistantMock.activeMode.value = 'chat';
    assistantMock.acpUsage.usage.value = {
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    };
    useAiAssistantMock.mockReturnValue(assistantMock);

    mountPanel(assistantMock);

    expect(latestTokenContextArgs?.officialUsage?.value).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    });
  });

  it('exposes no official usage when neither ACP nor plan usage is present (chat mode)', () => {
    const assistantMock = createAssistantMock([createMessage('message-user', 'user', 'hi')]);
    assistantMock.activeMode.value = 'chat';
    useAiAssistantMock.mockReturnValue(assistantMock);

    mountPanel(assistantMock);

    expect(latestTokenContextArgs?.officialUsage?.value ?? null).toBeNull();
  });
});`,
    'toHaveBeenCalledTimes(1)',
  ],
]);