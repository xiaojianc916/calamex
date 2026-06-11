import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { makeToolExecutionContext } from '../../test-support/tool-context.js';
import { type IMcpServerConfig } from '../mcp.js';
import { createMcpGatewayWarmPool } from './warm-pool.js';

const createMockStdioConfig = (name: string): IMcpServerConfig => ({
  name,
  transportType: 'stdio',
  command: 'mock-command',
  args: [],
  env: {},
  cwd: resolve('.'),
});

describe('MCP gateway warm pool lifecycle', () => {
  it('shares one shutdown task when disconnectAll is called concurrently', async () => {
    let disconnectCalls = 0;
    let releaseDisconnect!: () => void;
    const disconnectStarted = new Promise<void>((resolveStarted) => {
      releaseDisconnect = resolveStarted;
    });

    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [createMockStdioConfig('git')],
        errors: [],
        tools: {
          git_status: createTool({
            id: 'git_status',
            description: '读取 Git 状态',
            inputSchema: z.object({}),
            execute: async () => ({ status: 'clean' }),
          }),
        },
        disconnectAll: async () => {
          disconnectCalls += 1;
          await disconnectStarted;
        },
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    await executeCall({
      serverName: 'git',
      toolName: 'status',
      arguments: {},
    }, makeToolExecutionContext());

    const disconnects = Promise.all([
      pool.disconnectAll(),
      pool.disconnectAll(),
      pool.disconnectAll(),
    ]);

    await Promise.resolve();
    assert.equal(disconnectCalls, 1);

    releaseDisconnect?.();
    await disconnects;
    await pool.disconnectAll();

    assert.equal(disconnectCalls, 1);
  });

  it('rejects new MCP work after terminal shutdown starts', async () => {
    let releaseCreate!: (bundle: Awaited<ReturnType<Parameters<typeof createMcpGatewayWarmPool>[0]['createBundle']>>) => void;
    let disconnectCalls = 0;
    const createBundlePromise = new Promise<Awaited<ReturnType<Parameters<typeof createMcpGatewayWarmPool>[0]['createBundle']>>>((resolveCreate) => {
      releaseCreate = resolveCreate;
    });
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => createBundlePromise,
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    const firstCall = executeCall({
      serverName: 'git',
      toolName: 'status',
      arguments: {},
    }, makeToolExecutionContext());
    const shutdown = pool.disconnectAll();

    releaseCreate?.({
      configs: [createMockStdioConfig('git')],
      errors: [],
      tools: {
        git_status: createTool({
          id: 'git_status',
          description: '读取 Git 状态',
          inputSchema: z.object({}),
          execute: async () => ({ status: 'clean' }),
        }),
      },
      disconnectAll: async () => {
        disconnectCalls += 1;
      },
    });

    await assert.rejects(firstCall, /未完成初始化|已关闭/u);
    await shutdown;

    assert.equal(disconnectCalls, 1);
    await assert.rejects(
      async () => executeCall({
        serverName: 'git',
        toolName: 'status',
        arguments: {},
      }, makeToolExecutionContext()),
      /MCP gateway warm pool 已关闭/u,
    );
  });
});
