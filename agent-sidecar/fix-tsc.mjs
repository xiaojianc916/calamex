// fix-tsc.mjs —— 在 agent-sidecar/ 目录运行：  node fix-tsc.mjs
// 然后再跑：  pnpm tsc --noEmit  验证。
// 原地修改、不生成备份（可用 git restore / git diff 回滚审阅）。
// 逐条锚点替换；每条都做出现次数断言，匹配数不符就跳过该条并告警，不会写坏文件。
// 幂等：已应用过的编辑会被识别并跳过。CRLF/LF 自适配。

import { readFileSync, writeFileSync } from 'node:fs';

/** @type {Record<string, Array<{label:string, find:string, replace?:string, count?:number, deletion?:boolean}>>} */
const groups = {
  // ── 1. src/acp/to-runtime-input.spec.ts（TAB 缩进）──────────────────
  'src/acp/to-runtime-input.spec.ts': [
    {
      label: '为 c.ts resource 补 as ContentBlock 断言',
      find:
        '\t\tcontentBlockToText({\n' +
        '\t\t\ttype: "resource",\n' +
        '\t\t\tresource: { uri: "file:///c.ts" },\n' +
        '\t\t}),',
      replace:
        '\t\tcontentBlockToText({\n' +
        '\t\t\ttype: "resource",\n' +
        '\t\t\tresource: { uri: "file:///c.ts" },\n' +
        '\t\t} as ContentBlock),',
    },
  ],

  // ── 2. src/acp/turn-egress.spec.ts（TAB 缩进）──────────────────────
  'src/acp/turn-egress.spec.ts': [
    {
      label: '解构后断言 note 非空（修 18048 ×5）',
      find:
        '\tconst [note] = trailer.notifications\n' +
        '\tassert.equal(note.sessionId, SESSION_ID)',
      replace:
        '\tconst [note] = trailer.notifications\n' +
        '\tassert.ok(note)\n' +
        '\tassert.equal(note.sessionId, SESSION_ID)',
    },
  ],

  // ── 3. src/engines/bm25-tokenizer.ts ───────────────────────────────
  'src/engines/bm25-tokenizer.ts': [
    {
      label: '本地定义 TokenizeOptions（1.41 不再导出，修 TS2305）',
      find: "import type { TokenizeOptions } from '@mastra/core/workspace';",
      replace:
        '// @mastra/core/workspace 1.41 不再导出 TokenizeOptions（其 BM25Config 仅含 { k1, b }）。\n' +
        '// 这里内置仅覆盖本模块实际所需 tokenizer 字段的等价结构定义。\n' +
        'interface TokenizeOptions {\n' +
        '    tokenizer: (text: string) => string[];\n' +
        '}',
    },
  ],

  // ── 4. src/engines/policy/tool-descriptor.ts（4 空格缩进）───────────
  'src/engines/policy/tool-descriptor.ts': [
    {
      label: 'hasRequiredCapability 末尾补 return false（修 TS2366）',
      find:
        "        case 'network':\n" +
        '            return capabilities.supportsNetworkTools === true;\n' +
        '    }\n' +
        '};',
      replace:
        "        case 'network':\n" +
        '            return capabilities.supportsNetworkTools === true;\n' +
        '    }\n' +
        '\n' +
        '    return false;\n' +
        '};',
    },
  ],

  // ── 5. src/engines/session/agent-session.spec.ts（2 空格缩进）───────
  'src/engines/session/agent-session.spec.ts': [
    {
      label: 'first/second/checkpoint 收窄为 agent_event（修 64-69）',
      find:
        "  assert.equal(first.event.runId, 'run-1');\n" +
        '  assert.equal(first.event.seq, 0);\n' +
        "  assert.equal(second.event.runId, 'run-1');\n" +
        '  assert.equal(second.event.seq, 1);\n' +
        "  assert.equal(checkpoint.event.runId, 'run-2');\n" +
        '  assert.equal(checkpoint.event.seq, 0);',
      replace:
        "  if (first.type !== 'agent_event' || second.type !== 'agent_event' || checkpoint.type !== 'agent_event') {\n" +
        "    throw new Error('expected agent_event outputs');\n" +
        '  }\n' +
        "  assert.equal(first.event.runId, 'run-1');\n" +
        '  assert.equal(first.event.seq, 0);\n' +
        "  assert.equal(second.event.runId, 'run-1');\n" +
        '  assert.equal(second.event.seq, 1);\n' +
        "  assert.equal(checkpoint.event.runId, 'run-2');\n" +
        '  assert.equal(checkpoint.event.seq, 0);',
    },
    {
      label: 'events.map 内联收窄（修 202）',
      find: '  assert.deepEqual(session.events.map((event) => event.event.type), [',
      replace:
        "  assert.deepEqual(session.events.map((event) => (event.type === 'agent_event' ? event.event.type : event.type)), [",
    },
    {
      label: 'dispose mcp-bundle 改块体返回 void（修 216）',
      find: "    dispose: () => disposed.push('mcp-bundle'),",
      replace: "    dispose: () => { disposed.push('mcp-bundle'); },",
    },
    {
      label: 'dispose workspace 改块体返回 void（修 220）',
      find: "    dispose: () => disposed.push('workspace'),",
      replace: "    dispose: () => { disposed.push('workspace'); },",
    },
    {
      label: 'dispose first 改块体返回 void（修 241）',
      find: "    dispose: () => disposed.push('first'),",
      replace: "    dispose: () => { disposed.push('first'); },",
    },
    {
      label: 'dispose last 改块体返回 void（修 251）',
      find: "    dispose: () => disposed.push('last'),",
      replace: "    dispose: () => { disposed.push('last'); },",
    },
  ],

  // ── 6. src/engines/session/compaction-runner.spec.ts（2 空格缩进）──
  'src/engines/session/compaction-runner.spec.ts': [
    {
      label: 'events.map 内联收窄（修 61）',
      find: '  assert.deepEqual(session.events.map((event) => event.event.type), [',
      replace:
        "  assert.deepEqual(session.events.map((event) => (event.type === 'agent_event' ? event.event.type : event.type)), [",
    },
    {
      label: 'completedEvent 先收窄 agent_event（修 70）',
      find: '  const completedEvent = session.events.at(-1)?.event;',
      replace:
        '  const lastEvent = session.events.at(-1);\n' +
        "  const completedEvent = lastEvent?.type === 'agent_event' ? lastEvent.event : undefined;",
    },
  ],

  // ── 7. src/engines/session/session-messages.ts（2 空格缩进）────────
  'src/engines/session/session-messages.ts': [
    {
      label: 'prompt 分支限定 user 后再覆盖 content（修 357）',
      find:
        '        messageIndex === index\n' +
        '          ? {\n' +
        '            ...message,',
      replace:
        "        messageIndex === index && message.kind === 'user'\n" +
        '          ? {\n' +
        '            ...message,',
    },
    {
      label: 'user/assistant 分支拆开以匹配各自 content 类型（修 382）',
      find:
        "    if (message.kind === 'user' || message.kind === 'assistant') {\n" +
        '      return [{\n' +
        '        role: message.kind,\n' +
        '        content: message.content,\n' +
        '      }];\n' +
        '    }',
      replace:
        "    if (message.kind === 'user') {\n" +
        '      return [{\n' +
        "        role: 'user',\n" +
        '        content: message.content,\n' +
        '      }];\n' +
        '    }\n' +
        '\n' +
        "    if (message.kind === 'assistant') {\n" +
        '      return [{\n' +
        "        role: 'assistant',\n" +
        '        content: message.content,\n' +
        '      }];\n' +
        '    }',
    },
  ],

  // ── 8. src/engines/workspace.spec.ts（4 空格缩进）──────────────────
  'src/engines/workspace.spec.ts': [
    {
      label: 'tokenLimiter 经 unknown 再断言（修 TS2352）',
      find: '        (tokenLimiter as { getMaxTokens: () => number }).getMaxTokens(),',
      replace: '        (tokenLimiter as unknown as { getMaxTokens: () => number }).getMaxTokens(),',
    },
  ],

  // ── 9. src/engines/workspace.ts（4/8 空格缩进）────────────────────
  'src/engines/workspace.ts': [
    {
      label: 'bm25 改为 true（1.41 不支持自定义 tokenize，修 TS2353）',
      find:
        '        bm25: {\n' +
        '            tokenize: createWorkspaceBm25TokenizeOptions(),\n' +
        '        },',
      replace:
        '        // BM25 关键字检索：@mastra/core 1.41 的 WorkspaceConfig.bm25 仅接受 boolean | { k1, b }，\n' +
        '        // 不再转发自定义 tokenize（见 mastra issue #17636），即便传入也会在运行时被忽略。\n' +
        '        // 故改用 bm25: true 启用内置分词；CJK 感知分词器（bm25-tokenizer.ts）暂留待 Mastra 支持后再接回。\n' +
        '        bm25: true,',
    },
    {
      label: '删除因上一步变为未使用的 import（防 noUnusedLocals）',
      deletion: true,
      find: "import { createWorkspaceBm25TokenizeOptions } from './bm25-tokenizer.js';\n",
    },
  ],

  // ── 10. src/http/warmup.spec.ts（2/4 空格缩进）────────────────────
  'src/http/warmup.spec.ts': [
    {
      label: 'RequestInfo → string | URL | Request（修 50）',
      find: '((_input: RequestInfo | URL, init?: RequestInit) => {',
      replace: '((_input: string | URL | Request, init?: RequestInit) => {',
    },
    {
      label: 'capturedSignal 初值带类型断言，避免被收窄为 null（修 68/71）',
      find: '    let capturedSignal: AbortSignal | null = null;',
      replace: '    let capturedSignal: AbortSignal | null = null as AbortSignal | null;',
    },
  ],

  // ── 11. src/models/providers/deepseek-reasoning-fetch.ts ──────────
  'src/models/providers/deepseek-reasoning-fetch.ts': [
    {
      label: 'RequestInfo → string | URL | Request（×5）',
      find: 'RequestInfo | URL',
      replace: 'string | URL | Request',
      count: 5,
    },
  ],

  // ── 12. src/tools/mcp.spec.ts（2/4 空格缩进）──────────────────────
  'src/tools/mcp.spec.ts': [
    {
      label: 'catalog 参数显式标注 unknown（修 TS7006）',
      find: '    assert.equal(new Set(catalogs.map((catalog) => catalog)).size, 1);',
      replace: '    assert.equal(new Set(catalogs.map((catalog: unknown) => catalog)).size, 1);',
    },
  ],

  // ── 13. src/tools/mcp-gateway/capability.ts（2 空格缩进）──────────
  'src/tools/mcp-gateway/capability.ts': [
    {
      label: '新增 requiresMcpToolApproval 门面导出',
      find:
        '): boolean => resolveDescriptorApprovalDefault(\n' +
        '  createMcpGatewayToolDescriptor(serverName, toolName, annotations),\n' +
        ") === 'confirm';",
      replace:
        '): boolean => resolveDescriptorApprovalDefault(\n' +
        '  createMcpGatewayToolDescriptor(serverName, toolName, annotations),\n' +
        ") === 'confirm';\n" +
        '\n' +
        '// 工具名无关的审批门面：MCP 审批默认只取决于 server 与 annotations，不依赖具体 toolName，\n' +
        '// 故以空 toolName 复用 descriptor 审批规则。\n' +
        'export const requiresMcpToolApproval = (\n' +
        '  serverName: TMcpServerName,\n' +
        '  annotations: IMcpToolAnnotations | undefined,\n' +
        "): boolean => resolveMcpToolApprovalDefault(serverName, '', annotations);",
    },
  ],

  // ── 14. src/tools/mcp-gateway.ts（barrel，2 空格缩进）─────────────
  'src/tools/mcp-gateway.ts': [
    {
      label: 'barrel 再导出 requiresMcpToolApproval（修 approval.spec TS2305）',
      find:
        'export {\n' +
        '  createMcpGatewayToolDescriptor,\n' +
        '  readMcpToolAnnotations,\n' +
        '  resolveMcpToolApprovalDefault,\n' +
        '  resolveMcpToolCapability,\n' +
        "} from './mcp-gateway/capability.js';",
      replace:
        'export {\n' +
        '  createMcpGatewayToolDescriptor,\n' +
        '  readMcpToolAnnotations,\n' +
        '  requiresMcpToolApproval,\n' +
        '  resolveMcpToolApprovalDefault,\n' +
        '  resolveMcpToolCapability,\n' +
        "} from './mcp-gateway/capability.js';",
    },
  ],

  // ── 15. src/tools/mcp-gateway/warm-pool.lifecycle.spec.ts（4 空格）─
  'src/tools/mcp-gateway/warm-pool.lifecycle.spec.ts': [
    {
      label: 'releaseDisconnect 用确定赋值断言（修 71 never）',
      find: '    let releaseDisconnect: (() => void) | null = null;',
      replace: '    let releaseDisconnect!: () => void;',
    },
    {
      label: 'releaseCreate 用确定赋值断言（修 103 never）',
      find:
        "    let releaseCreate: ((bundle: Awaited<ReturnType<Parameters<typeof createMcpGatewayWarmPool>[0]['createBundle']>>) => void) | null = null;",
      replace:
        "    let releaseCreate!: (bundle: Awaited<ReturnType<Parameters<typeof createMcpGatewayWarmPool>[0]['createBundle']>>) => void;",
    },
  ],

  // ── 16. src/server.spec.ts（2 空格缩进）───────────────────────────
  'src/server.spec.ts': [
    {
      label: '导入 resolveAgentModelCapabilities',
      find: "import type { IMastraResolvedModelConfig } from './models/config.js';",
      replace:
        "import type { IMastraResolvedModelConfig } from './models/config.js';\n" +
        "import { resolveAgentModelCapabilities } from './models/capabilities.js';",
    },
    {
      label: 'createTestModelConfig 计算 capabilities（修 186）',
      find:
        '): IMastraResolvedModelConfig => ({\n' +
        "  modelId: 'deepseek/deepseek-chat',\n" +
        "  providerId: 'deepseek',\n" +
        "  providerModelId: 'deepseek-chat',\n" +
        "  apiKey: 'test-key',\n" +
        "  baseUrl: 'https://example.com/v1',\n" +
        '  customGateways: [\n' +
        '    createDeepSeekMastraGateway({\n' +
        "      apiKey: 'test-key',\n" +
        "      baseUrl: 'https://example.com/v1',\n" +
        '    }),\n' +
        '  ],\n' +
        '  model: new ModelRouterLanguageModel({\n' +
        "    providerId: 'deepseek',\n" +
        "    modelId: 'deepseek-chat',\n" +
        "    apiKey: 'test-key',\n" +
        "    url: 'https://example.com/v1',\n" +
        '  }),\n' +
        '  ...overrides,\n' +
        '});',
      replace:
        '): IMastraResolvedModelConfig => {\n' +
        '  const base = {\n' +
        "    modelId: 'deepseek/deepseek-chat',\n" +
        "    providerId: 'deepseek',\n" +
        "    providerModelId: 'deepseek-chat',\n" +
        "    apiKey: 'test-key',\n" +
        "    baseUrl: 'https://example.com/v1',\n" +
        '    customGateways: [\n' +
        '      createDeepSeekMastraGateway({\n' +
        "        apiKey: 'test-key',\n" +
        "        baseUrl: 'https://example.com/v1',\n" +
        '      }),\n' +
        '    ],\n' +
        '    model: new ModelRouterLanguageModel({\n' +
        "      providerId: 'deepseek',\n" +
        "      modelId: 'deepseek-chat',\n" +
        "      apiKey: 'test-key',\n" +
        "      url: 'https://example.com/v1',\n" +
        '    }),\n' +
        '    ...overrides,\n' +
        '  };\n' +
        '\n' +
        '  return {\n' +
        '    ...base,\n' +
        '    capabilities: overrides.capabilities ?? resolveAgentModelCapabilities({\n' +
        '      providerId: base.providerId,\n' +
        '      providerModelId: base.providerModelId,\n' +
        '      modelId: base.modelId,\n' +
        '    }),\n' +
        '  };\n' +
        '};',
    },
    {
      label: 'RequestInfo → string | URL | Request（修 866/927/1044/1113）',
      find: '(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {',
      replace: '(async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {',
      count: 4,
    },
    {
      label: "doneEvent 比较前放宽 type（修 1963 TS2367)",
      find: "stripTokenBudgetEvents(response.events).find((event) => event.type === 'done')",
      replace: "stripTokenBudgetEvents(response.events).find((event) => (event as { type?: unknown }).type === 'done')",
    },
  ],
};

let applied = 0, already = 0, failed = 0;
const failures = [];

for (const [file, edits] of Object.entries(groups)) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`✗ 读取失败 ${file}: ${e.message}`);
    failures.push(`${file}（读取失败）`);
    continue;
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const norm = (s) => (eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);
  const original = content;

  for (const edit of edits) {
    const find = norm(edit.find);
    const replace = norm(edit.replace ?? '');
    const expected = edit.count ?? 1;
    const occ = content.split(find).length - 1;

    if (edit.deletion) {
      if (occ >= 1) {
        content = content.split(find).join('');
        console.log(`  ✓ [${file}] ${edit.label}`);
        applied++;
      } else {
        console.log(`  • [${file}] ${edit.label}（已删除/不存在，跳过）`);
        already++;
      }
      continue;
    }

    if (occ === expected) {
      content = content.split(find).join(replace);
      console.log(`  ✓ [${file}] ${edit.label}`);
      applied++;
    } else if (occ === 0 && replace && content.includes(replace)) {
      console.log(`  • [${file}] ${edit.label}（已应用，跳过）`);
      already++;
    } else {
      console.error(`  ✗ [${file}] ${edit.label} —— 锚点命中 ${occ} 处，期望 ${expected}；已跳过该条，未改动。`);
      failures.push(`${file}: ${edit.label}`);
      failed++;
    }
  }

  if (content !== original) {
    writeFileSync(file, content, 'utf8');
    console.log(`写入 ${file}`);
  }
}

console.log(`\n完成：应用 ${applied}，已应用跳过 ${already}，失败 ${failed}`);
if (failures.length > 0) {
  console.error('需人工检查：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
}