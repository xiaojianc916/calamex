import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { makeToolExecutionContext } from '../test-support/tool-context.js';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { createMcpGatewayWarmPool } from './mcp-gateway.js';
import {
  createMastraMcpClientBundle,
  getMcpRuntimeStatus,
  loadMcpServerConfigs,
  MCP_SERVER_NAMES,
  type IMcpServerConfig,
} from './mcp.js';

const WORKSPACE_ROOT = resolve('D:/com.xiaojianc/my_desktop_app');
const MEMORY_FILE_PATH = join(WORKSPACE_ROOT, 'tmp', 'mcp-memory-test.jsonl');
const UVX_FIXTURE_PATH = join(tmpdir(), 'xiaojianc-mcp-fixtures', 'uvx.exe');
const GIT_FIXTURE_PATH = join(tmpdir(), 'xiaojianc-mcp-fixtures', 'git.exe');
const LOGOSCOPE_EXECUTABLE_PATH = resolve(WORKSPACE_ROOT, 'agent-sidecar', 'node_modules', '.bin', 'logoscope.CMD');
const LOGOSCOPE_MISSING_ERROR = `MCP server 可执行文件不存在：${LOGOSCOPE_EXECUTABLE_PATH}`;

mkdirSync(dirname(UVX_FIXTURE_PATH), { recursive: true });
writeFileSync(UVX_FIXTURE_PATH, '', 'utf8');
writeFileSync(GIT_FIXTURE_PATH, '', 'utf8');

const defaultEnv = {
  AGENT_MCP_MEMORY_FILE_PATH: MEMORY_FILE_PATH,
  AGENT_MCP_UVX_PATH: UVX_FIXTURE_PATH,
  AGENT_MCP_GIT_EXECUTABLE_PATH: GIT_FIXTURE_PATH,
  GITHUB_MCP_PAT: 'ghp-test-token',
  TAVILY_API_KEY: 'tvly-test-key',
};

const createMockStdioConfig = (name: string): IMcpServerConfig => ({
  name,
  transportType: 'stdio',
  command: 'mock-command',
  args: [],
  env: {},
  cwd: WORKSPACE_ROOT,
});

function assertStdioConfig(
  config: IMcpServerConfig | undefined,
  name: string,
): asserts config is Extract<IMcpServerConfig, { transportType: 'stdio' }> {
  assert.ok(config, `应找到 ${name} MCP 配置`);
  assert.equal(config.transportType, 'stdio');
}

function assertHttpConfig(
  config: IMcpServerConfig | undefined,
  name: string,
): asserts config is Extract<IMcpServerConfig, { transportType: 'http' }> {
  assert.ok(config, `应找到 ${name} MCP 配置`);
  assert.equal(config.transportType, 'http');
}

describe('MCP gateway warm pool', () => {
  it('reuses a warm bundle for repeated MCP tool calls', async () => {
    let createBundleCalls = 0;
    let disconnectCalls = 0;
    const pool = createMcpGatewayWarmPool({
      createBundle: async (options) => {
        createBundleCalls += 1;

        return {
          configs: [createMockStdioConfig(options?.serverNames?.[0] ?? 'git')],
          errors: [],
          tools: {
            git_status: createTool({
              id: 'git_status',
              description: '读取 Git 状态',
              inputSchema: z.object({
                repository: z.string(),
              }),
              execute: async (inputData) => ({
                repository: inputData.repository,
                status: 'clean',
              }),
            }),
          },
          disconnectAll: async () => {
            disconnectCalls += 1;
          },
        };
      },
      ttlIdleMs: 60_000,
    });
    const metricTypes: string[] = [];
    const toolsWithMetrics = pool.createTools({
      profile: 'write',
      metricSink: {
        emit: (metric) => {
          metricTypes.push(metric.type);
        },
      },
    });
    const executeCall = toolsWithMetrics.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    const first = await executeCall({
      serverName: 'git',
      toolName: 'status',
      arguments: { repository: '.' },
    }, makeToolExecutionContext());
    const second = await executeCall({
      serverName: 'git',
      toolName: 'git_status',
      arguments: { repository: '.' },
    }, makeToolExecutionContext());

    assert.deepEqual(first, {
      serverName: 'git',
      toolName: 'git_status',
      result: {
        repository: '.',
        status: 'clean',
      },
    });
    assert.deepEqual(second, first);
    assert.equal(createBundleCalls, 1);
    assert.equal(disconnectCalls, 0);
    assert.equal(metricTypes.includes('mcp_gateway.boot'), true);
    assert.equal(metricTypes.includes('mcp_gateway.call'), true);

    await pool.disconnectAll();
    assert.equal(disconnectCalls, 1);
  });

  it('deduplicates repeated all-server list calls through the catalog cache', async () => {
    let createBundleCalls = 0;
    const pool = createMcpGatewayWarmPool({
      createBundle: async (options) => {
        createBundleCalls += 1;
        const serverName = options?.serverNames?.[0] ?? 'probe';

        return {
          configs: [createMockStdioConfig(serverName)],
          errors: [],
          tools: {
            [`${serverName.replace(/-/gu, '_')}_search_code`]: createTool({
              id: `${serverName}_search_code`,
              description: '语义代码搜索',
              inputSchema: z.object({
                query: z.string(),
              }),
              execute: async () => ({ results: [] }),
            }),
          },
          disconnectAll: async () => undefined,
        };
      },
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeList = tools.mcp_list_tools.execute;

    assert.equal(typeof executeList, 'function');
    if (!executeList) {
      throw new Error('mcp_list_tools execute 不可用。');
    }

    const first = await executeList({}, makeToolExecutionContext());
    const second = await executeList({}, makeToolExecutionContext());

    assert.deepEqual(first, second);
    assert.equal(createBundleCalls, MCP_SERVER_NAMES.length);

    await pool.disconnectAll();
  });

  it('lists all MCP gateway catalogs with one tool call', async () => {
    const loadedServers: string[] = [];
    const pool = createMcpGatewayWarmPool({
      createBundle: async (options) => {
        const serverName = options?.serverNames?.[0] ?? 'unknown';
        loadedServers.push(serverName);

        return {
          configs: [createMockStdioConfig(serverName)],
          errors: [],
          tools: {
            [`${serverName.replace(/-/gu, '_')}_status`]: createTool({
              id: `${serverName}_status`,
              description: `${serverName} 状态`,
              inputSchema: z.object({}),
              execute: async () => ({ ok: true }),
            }),
          },
          disconnectAll: async () => undefined,
        };
      },
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeList = tools.mcp_list_tools.execute;

    assert.equal(typeof executeList, 'function');
    if (!executeList) {
      throw new Error('mcp_list_tools execute 不可用。');
    }

    const catalog = await executeList({}, makeToolExecutionContext());

    assert.equal(loadedServers.length, MCP_SERVER_NAMES.length);
    assert.deepEqual(
      catalog.catalogs.map((item: { serverName: string }) => item.serverName),
      MCP_SERVER_NAMES,
    );
    assert.deepEqual(Object.keys(catalog), ['profile', 'catalogs', 'errors']);
    assert.equal(catalog.catalogs.every((item: { tools: unknown[] }) => item.tools.length === 1), true);

    await pool.disconnectAll();
  });

  it('coalesces concurrent all-server catalog calls', async () => {
    let createBundleCalls = 0;
    const pool = createMcpGatewayWarmPool({
      createBundle: async (options) => {
        createBundleCalls += 1;
        const serverName = options?.serverNames?.[0] ?? 'unknown';

        return {
          configs: [createMockStdioConfig(serverName)],
          errors: [],
          tools: {
            [`${serverName.replace(/-/gu, '_')}_status`]: createTool({
              id: `${serverName}_status`,
              description: `${serverName} 状态`,
              inputSchema: z.object({}),
              execute: async () => ({ ok: true }),
            }),
          },
          disconnectAll: async () => undefined,
        };
      },
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeList = tools.mcp_list_tools.execute;

    assert.equal(typeof executeList, 'function');
    if (!executeList) {
      throw new Error('mcp_list_tools execute 不可用。');
    }

    const catalogs = await Promise.all(
      Array.from({ length: 10 }, () => executeList({}, makeToolExecutionContext())),
    );

    assert.equal(createBundleCalls, MCP_SERVER_NAMES.length);
    assert.equal(new Set(catalogs.map((catalog) => catalog)).size, 1);

    await pool.disconnectAll();
  });

  it('returns the full MCP catalog to the model without truncation', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async (options) => {
        const serverName = options?.serverNames?.[0] ?? 'context7';
        const serverPrefix = serverName.replace(/-/gu, '_');
        const tools = Object.fromEntries(
          Array.from({ length: 30 }, (_, index) => [
            `${serverPrefix}_tool_${index}`,
            createTool({
              id: `${serverPrefix}_tool_${index}`,
              description: `${serverName} 完整工具说明 ${index} ${'详细能力'.repeat(120)}CATALOG_DESCRIPTION_TAIL_${index}`,
              inputSchema: z.object({}),
              execute: async () => ({ ok: true }),
            }),
          ]),
        );

        return {
          configs: [createMockStdioConfig(serverName)],
          errors: [],
          tools,
          disconnectAll: async () => undefined,
        };
      },
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeList = tools.mcp_list_tools.execute;

    assert.equal(typeof executeList, 'function');
    if (!executeList) {
      throw new Error('mcp_list_tools execute 不可用。');
    }

    const catalog = await executeList({}, makeToolExecutionContext());
    const serialized = JSON.stringify(tools.mcp_list_tools.toModelOutput?.(catalog)) ?? '';

    assert.equal(typeof serialized, 'string');
    assert.match(serialized, /CATALOG_DESCRIPTION_TAIL_29/u);
    assert.doesNotMatch(serialized, /modelOutputTruncated|__modelOutputOmittedItems__|内容已截断/u);

    await pool.disconnectAll();
  });

  it('caps MCP call results before replaying them to the model', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [createMockStdioConfig('git')],
        errors: [],
        tools: {
          git_diff_unstaged: createTool({
            id: 'git_diff_unstaged',
            description: '读取未暂存 Git diff',
            inputSchema: z.object({
              repository: z.string(),
            }),
            execute: async () => ({
              diff: `${'diff 内容\n'.repeat(2_000)}MCP_RESULT_TAIL_SHOULD_NOT_REPLAY`,
            }),
          }),
        },
        disconnectAll: async () => undefined,
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    const rawResult = await executeCall({
      serverName: 'git',
      toolName: 'diff_unstaged',
      arguments: { repository: '.' },
    }, makeToolExecutionContext());
    const rawSerialized = JSON.stringify(rawResult) ?? '';
    const modelSerialized = JSON.stringify(tools.mcp_call_tool.toModelOutput?.(rawResult)) ?? '';

    assert.match(rawSerialized, /MCP_RESULT_TAIL_SHOULD_NOT_REPLAY/u);
    assert.doesNotMatch(modelSerialized, /MCP_RESULT_TAIL_SHOULD_NOT_REPLAY/u);
    assert.match(modelSerialized, /内容已截断|modelOutputTruncated/u);

    await pool.disconnectAll();
  });

  it('passes raw arguments to MCP tools before trying a Mastra-style context wrapper', async () => {
    let capturedInput: unknown = null;
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [createMockStdioConfig('tavily-mcp')],
        errors: [],
        tools: {
          tavily_mcp_tavily_search: createTool({
            id: 'tavily_mcp_tavily_search',
            description: '联网搜索',
            inputSchema: z.object({
              query: z.string(),
            }),
            execute: async (inputData) => {
              capturedInput = inputData;
              return {
                content: [{ type: 'text', text: '搜索完成' }],
                isError: false,
              };
            },
          }),
        },
        disconnectAll: async () => undefined,
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    const result = await executeCall({
      serverName: 'tavily-mcp',
      toolName: 'tavily_search',
      arguments: { query: '2026年5月 最新闻' },
    }, makeToolExecutionContext());

    assert.deepEqual(capturedInput, { query: '2026年5月 最新闻' });
    assert.deepEqual(result, {
      serverName: 'tavily-mcp',
      toolName: 'tavily_mcp_tavily_search',
      result: {
        content: [{ type: 'text', text: '搜索完成' }],
        isError: false,
      },
    });

    await pool.disconnectAll();
  });

  it('falls back to a Mastra-style context wrapper when a tool requires context input', async () => {
    let rawAttemptCount = 0;
    let wrappedAttemptCount = 0;
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [createMockStdioConfig('memory')],
        errors: [],
        tools: {
          memory_lookup: {
            description: '读取记忆',
            execute: async (inputData: unknown) => {
              const record = inputData as Record<string, unknown>;
              if ('context' in record) {
                wrappedAttemptCount += 1;
                return { key: (record.context as Record<string, unknown>).key, value: 'ok' };
              }

              rawAttemptCount += 1;
              throw new Error("Cannot read properties of undefined (reading 'context')");
            },
          },
        },
        disconnectAll: async () => undefined,
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    const result = await executeCall({
      serverName: 'memory',
      toolName: 'lookup',
      arguments: { key: 'session-1' },
    }, makeToolExecutionContext());

    assert.equal(rawAttemptCount, 1);
    assert.equal(wrappedAttemptCount, 1);
    assert.deepEqual(result, {
      serverName: 'memory',
      toolName: 'memory_lookup',
      result: {
        key: 'session-1',
        value: 'ok',
      },
    });

    await pool.disconnectAll();
  });

  it('reports readonly profile filtering separately from an empty MCP server', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [createMockStdioConfig('git')],
        errors: [],
        tools: {
          git_commit: createTool({
            id: 'git_commit',
            description: '创建 Git commit',
            inputSchema: z.object({
              message: z.string(),
            }),
            execute: async () => ({ ok: true }),
          }),
        },
        disconnectAll: async () => undefined,
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'readonly' });
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeCall, 'function');
    if (!executeCall) {
      throw new Error('mcp_call_tool execute 不可用。');
    }

    await assert.rejects(
      async () => executeCall({
        serverName: 'git',
        toolName: 'commit',
        arguments: { message: 'test' },
      }, makeToolExecutionContext()),
      /当前 readonly profile 不允许使用 git 的任何 MCP tool/u,
    );

    await pool.disconnectAll();
  });

  it('filters local file primitive duplicates out of MCP catalog and calls', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [createMockStdioConfig('git')],
        errors: [],
        tools: {
          git_read_file: createTool({
            id: 'git_read_file',
            description: '读取文件内容',
            inputSchema: z.object({
              path: z.string(),
            }),
            execute: async () => ({ ok: true }),
          }),
          git_write_file: createTool({
            id: 'git_write_file',
            description: '写入文件内容',
            inputSchema: z.object({
              path: z.string(),
              content: z.string(),
            }),
            execute: async () => ({ ok: true }),
          }),
        },
        disconnectAll: async () => undefined,
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeList = tools.mcp_list_tools.execute;
    const executeCall = tools.mcp_call_tool.execute;

    assert.equal(typeof executeList, 'function');
    assert.equal(typeof executeCall, 'function');
    if (!executeList || !executeCall) {
      throw new Error('MCP gateway tools execute 不可用。');
    }

    const catalogCollection = await executeList({}, makeToolExecutionContext());
    const catalog = catalogCollection.catalogs.find((item: { serverName: string }) => item.serverName === 'git');

    assert.deepEqual(catalog, {
      serverName: 'git',
      profile: 'write',
      tools: [],
      errors: [],
    });
    await assert.rejects(
      async () => executeCall({
        serverName: 'git',
        toolName: 'read_file',
        arguments: { path: 'README.md' },
      }, makeToolExecutionContext()),
      /file primitives 接管/u,
    );

    await pool.disconnectAll();
  });
});

describe('MCP sidecar config', () => {
  it('loads the built-in MCP servers', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
    });

    assert.deepEqual(loaded.errors, [LOGOSCOPE_MISSING_ERROR]);
    assert.deepEqual(loaded.configs.map((config) => config.name), [
      'git',
      'probe',
      'memory',
      'sequential-thinking',
      'github',
      'context7',
      'hooks-mcp',
      'tavily-mcp',
    ]);
  });

  it('wires workspace, memory and Tavily settings into official MCP server configs', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
    });
    const git = loaded.configs.find((config) => config.name === 'git');
    const probe = loaded.configs.find((config) => config.name === 'probe');
    const memory = loaded.configs.find((config) => config.name === 'memory');
    const github = loaded.configs.find((config) => config.name === 'github');
    const context7 = loaded.configs.find((config) => config.name === 'context7');
    const hooksMcp = loaded.configs.find((config) => config.name === 'hooks-mcp');
    const tavily = loaded.configs.find((config) => config.name === 'tavily-mcp');

    assertStdioConfig(git, 'git');
    assertStdioConfig(probe, 'probe');
    assertStdioConfig(memory, 'memory');
    assertHttpConfig(github, 'github');
    assertStdioConfig(context7, 'context7');
    assertStdioConfig(hooksMcp, 'hooks-mcp');
    assertStdioConfig(tavily, 'tavily-mcp');

    assert.equal(git.command, UVX_FIXTURE_PATH);
    assert.deepEqual(git.args, ['mcp-server-git==2026.1.14', '--repository', WORKSPACE_ROOT]);
    assert.equal(git.env?.GIT_PYTHON_GIT_EXECUTABLE, GIT_FIXTURE_PATH);
    assert.equal(probe.command, 'npx.cmd');
    assert.deepEqual(probe.args, ['-y', '@probelabs/probe@0.6.0-rc315', 'mcp']);
    assert.equal(memory.env?.MEMORY_FILE_PATH, MEMORY_FILE_PATH);
    assert.equal(github.url, 'https://api.githubcopilot.com/mcp/');
    assert.match(github.headers?.Authorization ?? '', /^Bearer\s+/u);
    assert.deepEqual(context7.args, []);
    assert.deepEqual(hooksMcp.args, ['hooks-mcp==0.2.4', '--working-directory', WORKSPACE_ROOT]);
    assert.equal(tavily.env?.TAVILY_API_KEY, 'tvly-test-key');
  });

  it('skips Tavily when its API key is missing', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        AGENT_MCP_MEMORY_FILE_PATH: MEMORY_FILE_PATH,
        AGENT_MCP_UVX_PATH: UVX_FIXTURE_PATH,
        AGENT_MCP_GIT_EXECUTABLE_PATH: GIT_FIXTURE_PATH,
      },
      platform: 'win32',
    });

    assert.equal(loaded.configs.some((config) => config.name === 'tavily-mcp'), false);
    assert.equal(loaded.errors.some((error) => /TAVILY_API_KEY/u.test(error)), true);
  });

  it('skips GitHub MCP when token is missing', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        ...defaultEnv,
        GITHUB_MCP_PAT: '',
      },
      platform: 'win32',
    });

    assert.equal(loaded.configs.some((config) => config.name === 'github'), false);
    assert.equal(loaded.errors.some((error) => /GITHUB_MCP_PAT/u.test(error)), true);
  });

  it('ignores legacy arbitrary MCP JSON so old tools are not loaded', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        ...defaultEnv,
        AGENT_MCP_SERVERS_JSON: JSON.stringify({
          mcpServers: {
            oldSearch: {
              command: 'node',
              args: ['D:/old/search.js'],
            },
          },
        }),
      },
      platform: 'win32',
    });

    assert.equal(loaded.configs.some((config) => config.name === 'oldSearch'), false);
    assert.deepEqual(loaded.configs.map((config) => config.name), [
      'git',
      'probe',
      'memory',
      'sequential-thinking',
      'github',
      'context7',
      'hooks-mcp',
      'tavily-mcp',
    ]);
  });

  it('limits MCP servers to the per-run allowlist without reporting unrequested server errors', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
      serverNames: ['probe', 'tavily-mcp'],
    });

    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.configs.map((config) => config.name), [
      'probe',
      'tavily-mcp',
    ]);
  });

  it('skips Git MCP when Windows git.exe cannot be resolved', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        ...defaultEnv,
        AGENT_MCP_GIT_EXECUTABLE_PATH: 'D:/missing/git.exe',
        ProgramFiles: join(tmpdir(), 'xiaojianc-missing-program-files'),
        'ProgramFiles(x86)': join(tmpdir(), 'xiaojianc-missing-program-files-x86'),
        LOCALAPPDATA: join(tmpdir(), 'xiaojianc-missing-local-app-data'),
      },
      platform: 'win32',
    });

    assert.equal(loaded.configs.some((config) => config.name === 'git'), false);
    assert.equal(
      loaded.errors.some((error) => error.includes('AGENT_MCP_GIT_EXECUTABLE_PATH')),
      true,
    );
  });

  it('exposes MCP health status for the Tauri health contract', () => {
    assert.deepEqual(getMcpRuntimeStatus({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
    }), {
      configuredServers: 8,
      serverNames: [
        'git',
        'probe',
        'memory',
        'sequential-thinking',
        'github',
        'context7',
        'hooks-mcp',
        'tavily-mcp',
      ],
      errors: [LOGOSCOPE_MISSING_ERROR],
    });
  });

  it('builds a Mastra-ready MCP bundle from the official MCPClient and keeps healthy tools when one configured server closes', async () => {
    const bundle = await createMastraMcpClientBundle({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
    });

    try {
      const toolNames = Object.keys(bundle.tools);
      const sequentialThinkingToolName = toolNames.find((toolName) => toolName.includes('sequentialthinking'));

      assert.ok(sequentialThinkingToolName);
      assert.equal(typeof bundle.tools[sequentialThinkingToolName], 'object');
      assert.equal(
        bundle.errors.some((error) => error.includes('git')),
        true,
      );
    } finally {
      await bundle.disconnectAll();
    }
  });

  it('disconnects MCP client bundles at most once', async () => {
    const bundle = await createMastraMcpClientBundle({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        AGENT_MCP_MEMORY_FILE_PATH: MEMORY_FILE_PATH,
      },
      platform: 'win32',
      serverNames: [],
    });
    let disconnectCalls = 0;
    const client = {
      disconnect: async () => {
        disconnectCalls += 1;
      },
    };
    const bundleWithClient = bundle as Omit<typeof bundle, 'client'> & {
      client: typeof client | null;
    };
    bundleWithClient.client = client;

    await Promise.all([
      bundleWithClient.disconnectAll(),
      bundleWithClient.disconnectAll(),
      bundleWithClient.disconnectAll(),
    ]);
    await bundleWithClient.disconnectAll();

    assert.equal(disconnectCalls, 1);
  });
});
