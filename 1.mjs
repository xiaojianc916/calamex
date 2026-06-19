#!/usr/bin/env node
/**
 * fix-batch6-mcp-parallel-fix.mjs — 修复 #61 脚本的类型错误
 *
 * 修复 "Type 'boolean' is not assignable to type 'true'" 错误。
 * 原因: ok: false as true 笔误，应为 ok: false as const。
 * 同时修复 null 返回值导致的 union 类型问题。
 *
 * 执行: node fix-batch6-mcp-parallel-fix.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = join(__dirname, 'agent-sidecar/src/tools/mcp/gateway/warm-pool.ts');

const original = readFileSync(filePath, 'utf-8');

// 修复1: ok: false as true → ok: false as const
let modified = original.replace(
  'return { ok: false as true, serverName, message };',
  'return { ok: false as const, serverName, message };',
);

// 修复2: worker 返回 null 的问题——改为让 results 的类型推断干净
// 把 Promise.allSettled 改为不用 null 哨兵，而是让 worker 在无任务时直接跳过
// 最简方案：让结果集用非 null 类型
modified = modified.replace(`        return null;`, `        return undefined;`);

// 修复3: byName 的类型需要接受 undefined 值
modified = modified.replace(
  `const byName = new Map<string, { ok: boolean; catalog?: IMcpGatewayCatalog; message?: string }>();`,
  `const byName = new Map<string, { ok: boolean; catalog?: IMcpGatewayCatalog; message?: string | undefined }>();`,
);

// 修复4: results 遍历跳过 undefined
modified = modified.replace(
  `      if (result.status === "fulfilled" && result.value) {`,
  `      if (result.status === "fulfilled" && result.value !== undefined) {`,
);

// 修复5: entry.message 可能是 undefined，push 时需要兜底
modified = modified.replace(
  `const message = entry.message ?? "Unknown error";`,
  `const message = entry.message ?? 'Unknown error';`,
);

if (original === modified) {
  console.log(
    'No change needed (patterns not found - file may already be fix#61 patched with different text).',
  );

  // 回退方案：直接替换整个方法
  const marker = 'private async listAllToolsUncached(';
  const startIdx = modified.indexOf(marker);
  if (startIdx === -1) {
    console.error('ERROR: Could not find listAllToolsUncached');
    process.exit(1);
  }

  const braceStart = modified.indexOf('{', startIdx);
  let depth = 1;
  let i = braceStart + 1;
  while (i < modified.length && depth > 0) {
    if (modified[i] === '{') depth++;
    else if (modified[i] === '}') depth--;
    i++;
  }
  const endIdx = i;

  const newMethod = [
    'private async listAllToolsUncached(input: {',
    '    profile: TMcpGatewayToolProfile;',
    '    workspaceRootPath?: string;',
    '    metricSink?: IMcpGatewayMetricSink;',
    '  }): Promise<IMcpGatewayCatalogCollection> {',
    '    const catalogs: IMcpGatewayCatalog[] = [];',
    '    const errors: string[] = [];',
    '',
    '    // 并行列举所有 MCP 服务工具：各服务互不依赖，串行等待会线性叠加',
    '    // spawn + listTools 延迟。并发度受 maxWarm 限制，避免同时 spawn 超过暖池上限',
    '    // 导致 spawn->evict 抖动。ensureEntry 内部的 evictOverflow + catalog 缓存保证：',
    '    // 即使被 evict 的服务，其 catalog 已在 bundle 创建成功时缓存。',
    '    const concurrency = Math.min(MCP_SERVER_NAMES.length, this.maxWarm);',
    '    let cursor = 0;',
    '    type TListResult = { ok: true; catalog: IMcpGatewayCatalog } | { ok: false; message: string };',
    '    const allResults: TListResult[] = [];',
    '',
    '    const workers = Array.from({ length: concurrency }, async () => {',
    '      while (cursor < MCP_SERVER_NAMES.length) {',
    '        const serverName = MCP_SERVER_NAMES[cursor] as TMcpServerName;',
    '        cursor += 1;',
    '        try {',
    '          const catalog = await this.listTools({',
    '            serverName,',
    '            profile: input.profile,',
    '            ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),',
    '            ...(input.metricSink ? { metricSink: input.metricSink } : {}),',
    '          });',
    '          allResults.push({ ok: true, catalog });',
    '        } catch (error) {',
    '          const message = error instanceof Error ? error.message : String(error);',
    '          allResults.push({ ok: false, message });',
    '        }',
    '      }',
    '    });',
    '    await Promise.allSettled(workers);',
    '',
    '    // 保持原始顺序：按 MCP_SERVER_NAMES 顺序整理结果',
    '    const byName = new Map<string, TListResult>();',
    '    for (const result of allResults) {',
    '      if (result.ok) {',
    '        byName.set(result.catalog.serverName, result);',
    '      }',
    '    }',
    '',
    '    for (const serverName of MCP_SERVER_NAMES) {',
    '      const entry = byName.get(serverName);',
    '      if (entry && entry.ok) {',
    '        catalogs.push(entry.catalog);',
    '        errors.push(...entry.catalog.errors.map((message) => `${serverName}: ${message}`));',
    '      } else {',
    "        const message = entry && !entry.ok ? entry.message : 'Unknown error';",
    '        errors.push(`${serverName}: ${message}`);',
    '        catalogs.push({',
    '          serverName,',
    '          profile: input.profile,',
    '          tools: [],',
    '          errors: [message],',
    '        });',
    '      }',
    '    }',
    '',
    '    return {',
    '      profile: input.profile,',
    '      catalogs,',
    '      errors,',
    '    };',
    '  }',
  ].join('\n');

  modified = original.slice(0, startIdx) + newMethod + original.slice(endIdx);
}

if (original === modified) {
  console.log('Still no change. Checking file state...');
  console.log(
    'First occurrence of listAllToolsUncached at:',
    original.indexOf('listAllToolsUncached'),
  );
  process.exit(1);
}

writeFileSync(filePath, modified, 'utf-8');
console.log('OK #61 warm-pool.ts: type errors fixed');
