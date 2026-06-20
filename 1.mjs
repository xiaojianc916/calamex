// 修复 token 字段重命名迁移遗留的类型不一致：promptTokens/completionTokens -> inputTokens/outputTokens
// 用法：项目根目录执行  node fix-token-field-migration.mjs
import { readFile, writeFile } from 'node:fs/promises';

function must(cond, msg) {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
}

async function patchFile(path, label, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    console.log(`• ${label}: 已是目标状态，跳过`);
    return;
  }
  await writeFile(path, after, 'utf8');
  console.log(`✓ ${label}: 已修补`);
}

// ① TSidecarStreamTokenSnapshot 的 Pick 键
await patchFile(
  'src/composables/ai/useAiAssistant.stream.ts',
  'TSidecarStreamTokenSnapshot Pick 键',
  (src) => {
    const OLD = "'promptTokens' | 'completionTokens' | 'totalTokens' | 'usage'";
    const NEW = "'inputTokens' | 'outputTokens' | 'totalTokens' | 'usage'";
    if (src.includes(NEW)) return src;
    must(src.includes(OLD), `stream.ts 未找到锚点: ${OLD}`);
    return src.replace(OLD, NEW);
  },
);

// ② TAgentUiEventDone 的扁平 token 字段
await patchFile(
  'src/types/ai/sidecar.ts',
  'TAgentUiEventDone 扁平 token 字段',
  (src) => {
    let out = src;
    if (!out.includes('\n  inputTokens?: number;')) {
      must(out.includes('\n  promptTokens?: number;'), 'sidecar.ts 未找到锚点: promptTokens?: number;');
      out = out.replace('\n  promptTokens?: number;', '\n  inputTokens?: number;');
    }
    if (!out.includes('\n  outputTokens?: number;')) {
      must(out.includes('\n  completionTokens?: number;'), 'sidecar.ts 未找到锚点: completionTokens?: number;');
      out = out.replace('\n  completionTokens?: number;', '\n  outputTokens?: number;');
    }
    return out;
  },
);

// ③ Kimi 用例 capturedRequest 捕获改读 mock.calls
await patchFile(
  'src/composables/ai/useAiAssistant.spec.ts',
  'Kimi 用例 capturedRequest 捕获方式',
  (src) => {
    if (src.includes('const capturedRequest = aiServiceMock.sidecarExternalChat.mock.calls[0]?.[0];')) {
      return src;
    }
    let out = src;

    const DECL_OLD =
      '    const promptGate = createDeferred<IAgentExternalChatResultPayload>();\n' +
      '    let capturedRequest: IAgentExternalChatRequest | null = null;\n\n' +
      '    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {\n' +
      '      capturedRequest = payload;\n';
    const DECL_NEW =
      '    const promptGate = createDeferred<IAgentExternalChatResultPayload>();\n\n' +
      '    aiServiceMock.sidecarExternalChat.mockImplementationOnce(async (payload) => {\n';
    must(out.includes(DECL_OLD), 'spec.ts 未找到锚点: capturedRequest 声明/赋值块');
    out = out.replace(DECL_OLD, DECL_NEW);

    const READ_OLD =
      "    expect(assistantMessageId).toBeTruthy();\n" +
      "    expect(capturedRequest?.backend).toBe('kimi');\n";
    const READ_NEW =
      "    expect(assistantMessageId).toBeTruthy();\n" +
      "    const capturedRequest = aiServiceMock.sidecarExternalChat.mock.calls[0]?.[0];\n" +
      "    expect(capturedRequest?.backend).toBe('kimi');\n";
    must(out.includes(READ_OLD), 'spec.ts 未找到锚点: capturedRequest 读取块');
    out = out.replace(READ_OLD, READ_NEW);

    return out;
  },
);

console.log('\n全部完成。建议执行：npx vue-tsc --noEmit  并重启 TS server。');