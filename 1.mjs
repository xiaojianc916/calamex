// fix-ai-composables-ts-errors.mjs
// 修复 src/composables/ai 下 4 个 TS 报错(见 PR 说明)。幂等、可重复运行。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();

/** 恰好替换一次;若锚点已消失且补丁标记已在,则视为已应用并跳过。 */
function applyEdit(content, file, { find, replace, applied }) {
  if (applied(content)) {
    console.log(`  • [${file}] 已应用,跳过`);
    return content;
  }
  const count = content.split(find).length - 1;
  if (count !== 1) {
    throw new Error(
      `[${file}] 锚点期望命中 1 次,实际 ${count} 次。文件可能与预期版本不一致,已中止。\n锚点开头: ${JSON.stringify(
        find.slice(0, 90),
      )}`,
    );
  }
  console.log(`  • [${file}] 已修补`);
  return content.replace(find, replace);
}

const FILES = {
  // ── 修复 1:删除未使用的 getActiveRun(ts6133) ──────────────────────────
  'src/composables/ai/useAiAgentRun.ts': [
    {
      find:
        `  const getRuns = (): IAiAgentRun[] => unref(store.runs);\n` +
        `  const getActiveRun = (): IAiAgentRun | null => unref(store.activeRun);\n` +
        `  const getPendingToolConfirmation = () => unref(store.pendingToolConfirmation);`,
      replace:
        `  const getRuns = (): IAiAgentRun[] => unref(store.runs);\n` +
        `  const getPendingToolConfirmation = () => unref(store.pendingToolConfirmation);`,
      applied: (c) => !c.includes('const getActiveRun'),
    },
  ],

  // ── 修复 2:计时器句柄类型钉成 number(ts2345)────────────────────────────
  'src/composables/ai/useAiAssistant.conversation-titles.ts': [
    {
      find:
        `  const pendingTitleRetryTimers = new Map<string, ReturnType<typeof window.setTimeout>>();`,
      replace: `  const pendingTitleRetryTimers = new Map<string, number>();`,
      applied: (c) =>
        c.includes('const pendingTitleRetryTimers = new Map<string, number>();'),
    },
  ],

  // ── 修复 3:IPC 边界把生成绑定窄化为域类型(ts2322)──────────────────────
  'src/composables/ai/useAiAssistant.provider-config.ts': [
    {
      find:
        `    config.value = (await aiService.getConfig()) ?? createDefaultAiConfigPayload();`,
      replace:
        `    config.value = ((await aiService.getConfig()) as IAiConfigPayload) ?? createDefaultAiConfigPayload();`,
      applied: (c) => c.includes('(await aiService.getConfig()) as IAiConfigPayload)'),
    },
    {
      find:
        `    config.value = await aiService.saveConfig({\n` +
        `      role,\n` +
        `      providerType:\n` +
        `        role === 'narrator' ? nextConfig.narrator.providerType : nextConfig.providerType,\n` +
        `      selectedModel:\n` +
        `        role === 'narrator' ? nextConfig.narrator.selectedModel : nextConfig.selectedModel,\n` +
        `      baseUrl: role === 'narrator' ? nextConfig.narrator.baseUrl : nextConfig.baseUrl,\n` +
        `      inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,\n` +
        `      chatEnabled: nextConfig.chatEnabled,\n` +
        `      agentEnabled: nextConfig.agentEnabled,\n` +
        `    });`,
      replace:
        `    config.value = (await aiService.saveConfig({\n` +
        `      role,\n` +
        `      providerType:\n` +
        `        role === 'narrator' ? nextConfig.narrator.providerType : nextConfig.providerType,\n` +
        `      selectedModel:\n` +
        `        role === 'narrator' ? nextConfig.narrator.selectedModel : nextConfig.selectedModel,\n` +
        `      baseUrl: role === 'narrator' ? nextConfig.narrator.baseUrl : nextConfig.baseUrl,\n` +
        `      inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,\n` +
        `      chatEnabled: nextConfig.chatEnabled,\n` +
        `      agentEnabled: nextConfig.agentEnabled,\n` +
        `    })) as IAiConfigPayload;`,
      applied: (c) => c.includes('config.value = (await aiService.saveConfig({'),
    },
    {
      find:
        `    config.value = await aiService.saveCredentials({\n` +
        `      providerId,\n` +
        `      alias,\n` +
        `      apiKey,\n` +
        `    });`,
      replace:
        `    config.value = (await aiService.saveCredentials({\n` +
        `      providerId,\n` +
        `      alias,\n` +
        `      apiKey,\n` +
        `    })) as IAiConfigPayload;`,
      applied: (c) => c.includes('config.value = (await aiService.saveCredentials({'),
    },
    {
      find: `    config.value = result.config;`,
      replace: `    config.value = result.config as IAiConfigPayload;`,
      applied: (c) => c.includes('result.config as IAiConfigPayload'),
    },
  ],

  // ── 修复 4:测试 helper 标注返回类型,收窄 providerType(ts2345)──────────
  'src/composables/ai/useAiAssistant.provider-config.spec.ts': [
    {
      find: `import { aiService } from '@/services/ipc/ai.service';`,
      replace:
        `import { aiService } from '@/services/ipc/ai.service';\n` +
        `import type { IAiConfigPayload } from '@/types/ai';`,
      applied: (c) => c.includes("import type { IAiConfigPayload } from '@/types/ai';"),
    },
    {
      find: `const buildConfigInput = () => ({`,
      replace: `const buildConfigInput = (): IAiConfigPayload => ({`,
      applied: (c) => c.includes('const buildConfigInput = (): IAiConfigPayload => ({'),
    },
  ],
};

let touched = 0;
for (const [rel, edits] of Object.entries(FILES)) {
  const abs = path.join(ROOT, rel);
  let content;
  try {
    content = await readFile(abs, 'utf8');
  } catch {
    throw new Error(`无法读取 ${rel} —— 请在项目根目录运行此脚本。`);
  }
  console.log(`» ${rel}`);
  const before = content;
  for (const e of edits) content = applyEdit(content, rel, e);
  if (content !== before) {
    await writeFile(abs, content, 'utf8');
    touched += 1;
    console.log(`  ✔ 已写回`);
  } else {
    console.log(`  = 无变化`);
  }
}
console.log(`\n完成,共改动 ${touched} 个文件。`);