#!/usr/bin/env node
/**
 * fix-batch6-mcp-parallel.mjs — #61: listAllToolsUncached 并行化
 *
 * 将串行 for-await 9 个 MCP 服务改为有限并发（受 maxWarm 限制），
 * 避免同时 spawn 超过暖池上限的子进程导致 spawn→evict→respawn 抖动。
 *
 * 执行: node fix-batch6-mcp-parallel.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = join(__dirname, 'agent-sidecar/src/tools/mcp/gateway/warm-pool.ts');

const original = readFileSync(filePath, 'utf-8');

// 精确定位 listAllToolsUncached 方法体
const marker = 'private async listAllToolsUncached(';
const startIdx = original.indexOf(marker);
if (startIdx === -1) {
  console.error('ERROR: Could not find listAllToolsUncached');
  process.exit(1);
}

// 找方法体结束：匹配大括号深度
const braceStart = original.indexOf('{', startIdx);
let depth = 1;
let i = braceStart + 1;
while (i < original.length && depth > 0) {
  if (original[i] === '{') depth++;
  else if (original[i] === '}') depth--;
  i++;
}
// i 指向 '}' 之后
const endIdx = i;

const oldMethod = original.slice(startIdx, endIdx);

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
  '    // spawn + listTools 延迟（每个未在暖池中的服务需 spawn 子进程，超时 30s）。',
  '    // 并发度受 maxWarm 限制，避免同时 spawn 超过暖池上限导致 spawn→evict 抖动。',
  '    // ensureEntry 内部的 evictOverflow + catalog 缓存保证：即使被 evict 的服务，',
  '    // 其 catalog 已在 bundle 创建成功时缓存，后续调用走缓存零开销。',
  '    const concurrency = Math.min(MCP_SERVER_NAMES.length, this.maxWarm);',
  '    let cursor = 0;',
  '    const results = await Promise.allSettled(',
  '      Array.from({ length: concurrency }, async () => {',
  '        while (cursor < MCP_SERVER_NAMES.length) {',
  '          const serverName = MCP_SERVER_NAMES[cursor] as TMcpServerName;',
  '          cursor += 1;',
  '          try {',
  '            const catalog = await this.listTools({',
  '              serverName,',
  '              profile: input.profile,',
  '              ...(input.workspaceRootPath ? { workspaceRootPath: input.workspaceRootPath } : {}),',
  '              ...(input.metricSink ? { metricSink: input.metricSink } : {}),',
  '            });',
  '            return { ok: true as const, serverName, catalog };',
  '          } catch (error) {',
  '            const message = error instanceof Error ? error.message : String(error);',
  '            return { ok: false as true, serverName, message };',
  '          }',
  '        }',
  '        return null;',
  '      }),',
  '    );',
  '',
  '    // 保持原始顺序：按 MCP_SERVER_NAMES 顺序整理结果',
  '    const byName = new Map<string, { ok: boolean; catalog?: IMcpGatewayCatalog; message?: string }>();',
  '    for (const result of results) {',
  '      if (result.status === "fulfilled" && result.value) {',
  '        byName.set(result.value.serverName, result.value);',
  '      }',
  '    }',
  '',
  '    for (const serverName of MCP_SERVER_NAMES) {',
  '      const entry = byName.get(serverName);',
  '      if (entry?.ok && entry.catalog) {',
  '        catalogs.push(entry.catalog);',
  '        errors.push(...entry.catalog.errors.map((message) => `${serverName}: ${message}`));',
  '      } else if (entry && !entry.ok) {',
  '        const message = entry.message ?? "Unknown error";',
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

const modified = original.slice(0, startIdx) + newMethod + original.slice(endIdx);

if (original === modified) {
  console.log('No change needed.');
} else {
  writeFileSync(filePath, modified, 'utf-8');
  console.log('OK #61 warm-pool.ts: listAllToolsUncached parallelized');
}