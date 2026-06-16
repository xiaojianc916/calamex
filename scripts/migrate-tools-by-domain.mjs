// scripts/migrate-tools-by-domain.mjs
// 一次性把 agent-sidecar/src/tools 重构为「按域」结构（含 engines/tools 原生工具收编）。
// 用法：在仓库根目录执行  node scripts/migrate-tools-by-domain.mjs
// 设计：git mv 保留历史 + 通用相对路径 import 重写 + 对 warm-pool 的精确断言式外科手术。
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { execSync } from 'node:child_process';

const SRC = 'agent-sidecar/src';
const ROOT = process.cwd();
if (!existsSync(join(ROOT, SRC))) {
  console.error(`✗ 找不到 ${SRC}；请在仓库根目录(含 agent-sidecar/)运行本脚本。`);
  process.exit(1);
}
const abs = (relUnderSrc) => resolve(ROOT, SRC, relUnderSrc);
const git = (cmd) => execSync(`git ${cmd}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const ensureDir = (p) => mkdirSync(dirname(p), { recursive: true });
const read = (p) => readFileSync(p, 'utf8');
const write = (p, c) => { ensureDir(p); writeFileSync(p, c, 'utf8'); };

// ── 精确替换（必须命中 expected 次，否则中止；防止文件漂移后静默改坏）──
function replaceExactly(file, find, repl, label, expected = 1) {
  const before = read(file);
  const count = before.split(find).length - 1;
  if (count !== expected) {
    console.error(`✗ [${label}] 期望命中 ${expected} 次，实际 ${count} 次：${file}`);
    console.error(`  → 文件可能已改动，请把当前内容发我，我更新脚本。已中止（未提交）。`);
    process.exit(1);
  }
  write(file, before.split(find).join(repl));
  console.log(`  ✓ ${label}`);
}

console.log('▶ Phase 1：抽出网关两个工具，slim 化 warm-pool.createTools（在旧路径上做）');
const WP = abs('tools/mcp-gateway/warm-pool.ts');

// 1a. 删掉仅被两个工具用到的导入（z / compactModelOutput / createJsonToolModelOutput）
replaceExactly(WP, `import { z } from 'zod';\n`, '', 'rm import z');
replaceExactly(WP, `import { compactModelOutput } from '../../models/output-budget.js';\n`, '', 'rm import compactModelOutput');
replaceExactly(WP, `import { createJsonToolModelOutput } from '../../engines/budget/budget.js';\n`, '', 'rm import createJsonToolModelOutput');

// 1b. 收窄 tool-helpers 导入（移走 schemas/unwrap，它们改由两个工具文件直接引用）
replaceExactly(WP,
`import {
  MCP_GATEWAY_TOOL_NAMES,
  createCatalogFromBundle,
  createCatalogKey,
  createPoolKey,
  createToolUnavailableError,
  executeMcpGatewayToolWithTimeout,
  filterMcpToolsForProfile,
  mcpGatewayCallInputSchema,
  mcpGatewayListInputSchema,
  mcpGatewayListLegacyInputSchema,
  readErrors,
  resolveMcpGatewayTool,
  unwrapGatewayToolInput,
} from './tool-helpers.js';`,
`import {
  MCP_GATEWAY_TOOL_NAMES,
  createCatalogFromBundle,
  createCatalogKey,
  createPoolKey,
  createToolUnavailableError,
  executeMcpGatewayToolWithTimeout,
  filterMcpToolsForProfile,
  readErrors,
  resolveMcpGatewayTool,
} from './tool-helpers.js';`,
'slim tool-helpers import');

// 1c. 在 metrics 导入后追加两个工具工厂的导入
replaceExactly(WP,
`import { McpGatewayMetricBuffer } from './metrics.js';`,
`import { McpGatewayMetricBuffer } from './metrics.js';
import { createMcpListTool } from './tools/list-tools.js';
import { createMcpCallTool } from './tools/call-tool.js';`,
'add tool factory imports');

// 1d. 删掉只被 mcp_call_tool 用的输出预算常量块
replaceExactly(WP,
`const MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS = 4_000;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS = 1_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS = 20;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS = 40;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH = 6;
`, '', 'rm model-output constants');

// 1e. mcp_list_tools createTool(...) → 委托工厂
replaceExactly(WP,
String.raw`      mcp_list_tools: createTool({
        id: 'mcp_list_tools',
        description: [
          '一次性列出所有 MCP server 的工具目录。',
          '这是无参数工具；不要为不同 server 重复调用，也不要传 serverName。',
          '目录来自 sidecar 缓存，完整返回所有可用工具名和描述，不暴露完整 schema。',
          '首次调用可能触发 MCP server 冷启动（可能数秒），后续调用走缓存。',
          '已知 tool 名称时应直接用 mcp_call_tool 调用，避免不必要的目录浏览。',
        ].join('\n'),
        inputSchema: mcpGatewayListInputSchema,
        execute: async (inputData) => {
          mcpGatewayListLegacyInputSchema.parse(unwrapGatewayToolInput(inputData));
          const baseInput = {
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          };

          return await this.listAllTools(baseInput);
        },
        toModelOutput: (output) => createJsonToolModelOutput(output),
      }),`,
`      mcp_list_tools: createMcpListTool(this, options),`,
'delegate mcp_list_tools');

// 1f. mcp_call_tool createTool(...) → 委托工厂
replaceExactly(WP,
String.raw`      mcp_call_tool: createTool({
        id: 'mcp_call_tool',
        description: [
          '直接按 serverName 和 toolName 调用 MCP 工具。',
          '已知道 tool 名称时应直接调用，只有不确定名称时才先用 mcp_list_tools 探索。',
        ].join('\n'),
        inputSchema: mcpGatewayCallInputSchema,
        requireApproval: async (rawInput) => {
          let parsed: z.infer<typeof mcpGatewayCallInputSchema>;
          try {
            parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(rawInput));
          } catch {
            // 无法解析调用目标 → 无法判定能力 → fail-closed。
            return true;
          }
          return await this.requiresToolApproval({
            serverName: parsed.serverName,
            toolName: parsed.toolName,
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          });
        },
        execute: async (inputData) => {
          const parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(inputData));
          return await this.callTool({
            serverName: parsed.serverName,
            toolName: parsed.toolName,
            arguments: parsed.arguments,
            profile: options.profile,
            ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
            ...(options.metricSink ? { metricSink: options.metricSink } : {}),
          });
        },
        toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
          maxTotalChars: MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS,
          maxStringChars: MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS,
          maxArrayItems: MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS,
          maxObjectKeys: MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS,
          maxDepth: MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH,
        })),
      }),`,
`      mcp_call_tool: createMcpCallTool(this, options),`,
'delegate mcp_call_tool');

console.log('▶ Phase 2：写入两个工具文件到最终路径（最终相对路径，无需 codemod）');
// 注意：以 git mv 完成目录搬迁后再创建这两个文件，路径已是最终位置。
const TOOLS_DIR = abs('tools/mcp/gateway/tools');

const LIST_TOOLS = String.raw`import { createTool } from '@mastra/core/tools';
import { createJsonToolModelOutput } from '../../../../engines/budget/budget.js';
import {
  mcpGatewayListInputSchema,
  mcpGatewayListLegacyInputSchema,
  unwrapGatewayToolInput,
} from '../helpers.js';
import type { McpGatewayWarmPool } from '../warm-pool.js';
import type { IMcpGatewayMetricSink, TMcpGatewayToolProfile } from '../types.js';

export interface IMcpGatewayToolOptions {
  workspaceRootPath?: string;
  profile: TMcpGatewayToolProfile;
  metricSink?: IMcpGatewayMetricSink;
}

// mcp_list_tools —— 一次性列出所有 MCP server 的工具目录（无参数；目录走 sidecar 缓存）。
export const createMcpListTool = (
  pool: McpGatewayWarmPool,
  options: IMcpGatewayToolOptions,
): ReturnType<typeof createTool> =>
  createTool({
    id: 'mcp_list_tools',
    description: [
      '一次性列出所有 MCP server 的工具目录。',
      '这是无参数工具；不要为不同 server 重复调用，也不要传 serverName。',
      '目录来自 sidecar 缓存，完整返回所有可用工具名和描述，不暴露完整 schema。',
      '首次调用可能触发 MCP server 冷启动（可能数秒），后续调用走缓存。',
      '已知 tool 名称时应直接用 mcp_call_tool 调用，避免不必要的目录浏览。',
    ].join('\n'),
    inputSchema: mcpGatewayListInputSchema,
    execute: async (inputData) => {
      mcpGatewayListLegacyInputSchema.parse(unwrapGatewayToolInput(inputData));
      const baseInput = {
        profile: options.profile,
        ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
        ...(options.metricSink ? { metricSink: options.metricSink } : {}),
      };
      return await pool.listAllTools(baseInput);
    },
    toModelOutput: (output) => createJsonToolModelOutput(output),
  });
`;

const CALL_TOOL = String.raw`import { createTool } from '@mastra/core/tools';
import type { z } from 'zod';
import { compactModelOutput } from '../../../../models/output-budget.js';
import { createJsonToolModelOutput } from '../../../../engines/budget/budget.js';
import { mcpGatewayCallInputSchema, unwrapGatewayToolInput } from '../helpers.js';
import type { McpGatewayWarmPool } from '../warm-pool.js';
import type { IMcpGatewayToolOptions } from './list-tools.js';

const MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS = 4_000;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS = 1_500;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS = 20;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS = 40;
const MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH = 6;

// mcp_call_tool —— 按 serverName + toolName 直接调用 MCP 工具；审批/执行委托给 warm pool。
export const createMcpCallTool = (
  pool: McpGatewayWarmPool,
  options: IMcpGatewayToolOptions,
): ReturnType<typeof createTool> =>
  createTool({
    id: 'mcp_call_tool',
    description: [
      '直接按 serverName 和 toolName 调用 MCP 工具。',
      '已知道 tool 名称时应直接调用，只有不确定名称时才先用 mcp_list_tools 探索。',
    ].join('\n'),
    inputSchema: mcpGatewayCallInputSchema,
    requireApproval: async (rawInput) => {
      let parsed: z.infer<typeof mcpGatewayCallInputSchema>;
      try {
        parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(rawInput));
      } catch {
        // 无法解析调用目标 → 无法判定能力 → fail-closed。
        return true;
      }
      return await pool.requiresToolApproval({
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        profile: options.profile,
        ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
        ...(options.metricSink ? { metricSink: options.metricSink } : {}),
      });
    },
    execute: async (inputData) => {
      const parsed = mcpGatewayCallInputSchema.parse(unwrapGatewayToolInput(inputData));
      return await pool.callTool({
        serverName: parsed.serverName,
        toolName: parsed.toolName,
        arguments: parsed.arguments,
        profile: options.profile,
        ...(options.workspaceRootPath ? { workspaceRootPath: options.workspaceRootPath } : {}),
        ...(options.metricSink ? { metricSink: options.metricSink } : {}),
      });
    },
    toModelOutput: (output) => createJsonToolModelOutput(compactModelOutput(output, {
      maxTotalChars: MCP_GATEWAY_MODEL_OUTPUT_MAX_CHARS,
      maxStringChars: MCP_GATEWAY_MODEL_OUTPUT_MAX_STRING_CHARS,
      maxArrayItems: MCP_GATEWAY_MODEL_OUTPUT_MAX_ARRAY_ITEMS,
      maxObjectKeys: MCP_GATEWAY_MODEL_OUTPUT_MAX_OBJECT_KEYS,
      maxDepth: MCP_GATEWAY_MODEL_OUTPUT_MAX_DEPTH,
    })),
  });
`;

console.log('▶ Phase 3：git mv 目录搬迁（保留历史）');
// [旧(相对 SRC), 新(相对 SRC)]
const realMoves = [
  ['tools/mcp.ts',                                   'tools/mcp/client.ts'],
  ['tools/mcp.spec.ts',                              'tools/mcp/client.spec.ts'],
  ['tools/mcp-gateway.ts',                           'tools/mcp/index.ts'],
  ['tools/mcp-gateway.approval.spec.ts',             'tools/mcp/gateway/approval.spec.ts'],
  ['tools/mcp-gateway/types.ts',                     'tools/mcp/gateway/types.ts'],
  ['tools/mcp-gateway/capability.ts',                'tools/mcp/gateway/capability.ts'],
  ['tools/mcp-gateway/capability.spec.ts',           'tools/mcp/gateway/capability.spec.ts'],
  ['tools/mcp-gateway/metrics.ts',                   'tools/mcp/gateway/metrics.ts'],
  ['tools/mcp-gateway/warm-pool.ts',                 'tools/mcp/gateway/warm-pool.ts'],
  ['tools/mcp-gateway/warm-pool.lifecycle.spec.ts',  'tools/mcp/gateway/warm-pool.lifecycle.spec.ts'],
  ['tools/mcp-gateway/tool-helpers.ts',              'tools/mcp/gateway/helpers.ts'],
  ['tools/time.ts',                                  'tools/time/index.ts'],
  ['tools/log.ts',                                   'tools/log/index.ts'],
  ['engines/tools/tools.ts',                         'tools/index.ts'],
  ['engines/tools/circuit-breaker.ts',               'tools/circuit-breaker.ts'],
  ['engines/tools/read-current-file.ts',             'tools/editor/read-current-file.ts'],
  ['engines/tools/ask-user.ts',                      'tools/interaction/ask-user.ts'],
  ['engines/tools/update-plan.ts',                   'tools/plan/update-plan.ts'],
  ['engines/tools/exit-plan.ts',                     'tools/plan/exit-plan.ts'],
];
for (const [oldRel, newRel] of realMoves) {
  const o = abs(oldRel), n = abs(newRel);
  if (!existsSync(o)) {
    console.error(`✗ 待搬迁文件不存在：${SRC}/${oldRel}（仓库结构可能已变，请发我现状）。已中止。`);
    process.exit(1);
  }
  mkdirSync(dirname(n), { recursive: true });
  git(`mv "${SRC}/${oldRel}" "${SRC}/${newRel}"`);
  console.log(`  ✓ ${oldRel} → ${newRel}`);
}

// 现在目录已就位，落地两个工具文件 + 让 git 跟踪
write(join(TOOLS_DIR, 'list-tools.ts'), LIST_TOOLS);
write(join(TOOLS_DIR, 'call-tool.ts'), CALL_TOOL);
git(`add "${SRC}/tools/mcp/gateway/tools/list-tools.ts" "${SRC}/tools/mcp/gateway/tools/call-tool.ts"`);
console.log('  ✓ 写入 mcp/gateway/tools/{list-tools,call-tool}.ts');

console.log('▶ Phase 4：全仓相对路径 import 重写（通用重映射）');
// 旧→新 路径表（含两个工具文件的「虚拟旧路径」，用于解析 warm-pool 里 './tools/*.js' 引用）
const remapPairs = [
  ...realMoves,
  ['tools/mcp-gateway/tools/list-tools.ts', 'tools/mcp/gateway/tools/list-tools.ts'],
  ['tools/mcp-gateway/tools/call-tool.ts',  'tools/mcp/gateway/tools/call-tool.ts'],
];
const movedMap = new Map();      // 旧 .ts 绝对路径 → 新 .ts 绝对路径
const oldAbsByNew = new Map();   // 新 .ts 绝对路径 → 旧 .ts 绝对路径（用于求 importer 的 oldDir）
for (const [oldRel, newRel] of remapPairs) {
  movedMap.set(abs(oldRel), abs(newRel));
  oldAbsByNew.set(abs(newRel), abs(oldRel));
}

const toPosix = (p) => p.split(sep).join('/');
const SPEC_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

let touched = 0;
for (const fileAbs of walk(abs(''))) {
  const oldDir = dirname(oldAbsByNew.get(fileAbs) ?? fileAbs); // 移动过的文件用旧目录解析其相对 import
  const newDir = dirname(fileAbs);
  const before = read(fileAbs);
  const after = before.replace(SPEC_RE, (m, lead, q, spec) => {
    if (!spec.endsWith('.js')) return m;                    // 仅处理 .js 后缀的 ESM 相对引用
    const base = spec.slice(0, -3);
    const targetOld = resolve(oldDir, base) + '.ts';
    const targetNew = movedMap.get(targetOld) ?? targetOld; // 目标若搬迁则映射，否则原样
    let rel = toPosix(relative(newDir, targetNew)).replace(/\.ts$/, '.js');
    if (!rel.startsWith('.')) rel = './' + rel;
    if (rel === spec) return m;
    return `${lead}${q}${rel}${q}`;
  });
  if (after !== before) { write(fileAbs, after); touched++; }
}
console.log(`  ✓ import 重写完成，改动 ${touched} 个文件`);

console.log('▶ Phase 5：tools/index.ts 头部登记三类工具来源 + 写 README');
const INDEX = abs('tools/index.ts');
const banner = `// ─────────────────────────────────────────────────────────────────
// agent-sidecar 工具中心（按域组织）。
// 工具来源分三类：
//   A. 自研工具（本目录，一工具一文件，可拆）：
//      time/（get_current_time, convert_time）、log/（mastra_list_logs）、
//      editor/（read_current_file）、interaction/（ask_user）、plan/（update_plan, exit_plan）、
//      mcp/gateway/tools/（mcp_list_tools, mcp_call_tool）。
//   B. 官方/SDK 工具（不在本仓库，无法拆文件）：workspace fs/sandbox/LSP/search、browser。
//      装配点保留在 engines/workspace.ts（createMastraWorkspace / createMastraBrowser）。
//   C. 外部 MCP 工具（运行时动态拉取）：经 mcp/ 网关聚合，详见 tools/README.md。
// 本文件 = 总装配器 loadMastraMcpTools，把 A 自研工具 + B 官方装配 + C 网关 统一组装。
// ─────────────────────────────────────────────────────────────────
`;
{
  const cur = read(INDEX);
  if (!cur.startsWith('// ────')) write(INDEX, banner + cur);
  console.log('  ✓ index.ts 头部登记');
}
write(abs('tools/README.md'), String.raw`# tools —— Agent 工具中心（按域）

按「域」组织，目标：一个 AI 工具一个文件、可独立扩展、后续重构不外溢。

## 目录
- \`index.ts\` —— 总装配器 \`loadMastraMcpTools\`，组装 A/B/C 三类工具。
- \`circuit-breaker.ts\` —— 工具错误熔断（跨域）。
- \`time/\` —— get_current_time, convert_time（+ shared）。
- \`log/\` —— mastra_list_logs（+ file-logger）。
- \`editor/\` —— read_current_file。
- \`interaction/\` —— ask_user。
- \`plan/\` —— update_plan, exit_plan。
- \`mcp/\` —— MCP 网关：\`client.ts\`（连接基建）、\`index.ts\`（barrel）、
  \`gateway/\`（warm-pool / helpers / capability / metrics / types）、
  \`gateway/tools/\`（mcp_list_tools, mcp_call_tool）。
- \`generated.ts\` —— 脚本生成的工具清单（勿手改）。

## 三类工具来源
- **A 自研**：本目录，可拆、可一工具一文件。
- **B 官方/SDK**：workspace、browser，定义在 \`@mastra/*\` 包内，无源文件可拆；
  装配点在 \`engines/workspace.ts\`，本次不搬，仅在此登记。
- **C 外部 MCP**：9 个 server 运行时拉取，经 \`mcp/\` 网关聚合，不落地为单文件。
`);
git(`add "${SRC}/tools/README.md"`);
console.log('  ✓ 写入 tools/README.md');

console.log('▶ Phase 6：清理校验');
const leftovers = [];
const oldDirsToCheck = ['engines/tools', 'tools/mcp-gateway'];
for (const d of oldDirsToCheck) {
  const p = abs(d);
  if (existsSync(p)) {
    const rest = walk(p, []);
    if (rest.length) leftovers.push(...rest.map((f) => toPosix(relative(ROOT, f))));
  }
}
for (const f of ['tools/mcp.ts', 'tools/mcp-gateway.ts', 'tools/time.ts', 'tools/log.ts']) {
  if (existsSync(abs(f))) leftovers.push(`${SRC}/${f}`);
}
if (leftovers.length) {
  console.warn('⚠ 检测到旧路径仍有残留文件（可能是我未覆盖的 spec/新增文件），请发我，我补进搬迁表：');
  for (const f of leftovers) console.warn(`   - ${f}`);
} else {
  console.log('  ✓ 旧目录无残留');
}

console.log(`
✅ 结构搬迁完成。接下来手动验证（脚本不自动提交）：
   1) cd agent-sidecar && pnpm build        # tsc 会暴露任何漏改的 import / 别名引用
   2) pnpm test                              # 重点：mcp.spec / capability.spec / warm-pool.lifecycle.spec / approval.spec / plan / ask_user
   3) git diff -M --stat                     # 用 -M 查看为「重命名」，确认历史保留
   4) 全部绿后：git add -A && git commit -m "refactor(tools): 按域重组 agent-sidecar/src/tools，一工具一文件"
`);