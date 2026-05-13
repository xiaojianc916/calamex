import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { createMcpGatewayWarmPool } from './mcp-gateway.js';
import {
  createMastraMcpClientBundle,
  getMcpRuntimeStatus,
  loadMcpServerConfigs,
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
  SQLITE_DB_PATH: join(WORKSPACE_ROOT, 'tmp', 'agent-sidecar.sqlite'),
  TAVILY_API_KEY: 'tvly-test-key',
};

describe('MCP gateway warm pool', () => {
  it('reuses a warm bundle for repeated MCP tool calls', async () => {
    let createBundleCalls = 0;
    let disconnectCalls = 0;
    const pool = createMcpGatewayWarmPool({
      createBundle: async (options) => {
        createBundleCalls += 1;

        return {
          configs: [{ name: options?.serverNames?.[0] ?? 'git', transportType: 'stdio' }],
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
    }, {});
    const second = await executeCall({
      serverName: 'git',
      toolName: 'git_status',
      arguments: { repository: '.' },
    }, {});

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

  it('serves repeated list calls from the catalog cache', async () => {
    let createBundleCalls = 0;
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => {
        createBundleCalls += 1;

        return {
          configs: [{ name: 'probe', transportType: 'stdio' }],
          errors: [],
          tools: {
            probe_search_code: createTool({
              id: 'probe_search_code',
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

    const first = await executeList({ serverName: 'probe' }, {});
    const second = await executeList({ serverName: 'probe' }, {});

    assert.deepEqual(first, second);
    assert.equal(createBundleCalls, 1);

    await pool.disconnectAll();
  });

  it('caps catalog descriptions returned to the model', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [{ name: 'context7', transportType: 'stdio' }],
        errors: [],
        tools: {
          context7_query_docs: createTool({
            id: 'context7_query_docs',
            description: `${'搜索说明'.repeat(120)}CATALOG_DESCRIPTION_TAIL`,
            inputSchema: z.object({
              query: z.string(),
            }),
            execute: async () => ({ results: [] }),
          }),
        },
        disconnectAll: async () => undefined,
      }),
      ttlIdleMs: 60_000,
    });
    const tools = pool.createTools({ profile: 'write' });
    const executeList = tools.mcp_list_tools.execute;

    assert.equal(typeof executeList, 'function');
    if (!executeList) {
      throw new Error('mcp_list_tools execute 不可用。');
    }

    const catalog = await executeList({ serverName: 'context7' }, {});
    const serialized = JSON.stringify(tools.mcp_list_tools.toModelOutput?.(catalog)) ?? '';

    assert.equal(typeof serialized, 'string');
    assert.doesNotMatch(serialized, /CATALOG_DESCRIPTION_TAIL/u);
    assert.match(serialized, /\.\.\./u);

    await pool.disconnectAll();
  });

  it('caps MCP call results before replaying them to the model', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [{ name: 'git', transportType: 'stdio' }],
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
    }, {});
    const rawSerialized = JSON.stringify(rawResult) ?? '';
    const modelSerialized = JSON.stringify(tools.mcp_call_tool.toModelOutput?.(rawResult)) ?? '';

    assert.match(rawSerialized, /MCP_RESULT_TAIL_SHOULD_NOT_REPLAY/u);
    assert.doesNotMatch(modelSerialized, /MCP_RESULT_TAIL_SHOULD_NOT_REPLAY/u);
    assert.match(modelSerialized, /内容已截断|modelOutputTruncated/u);

    await pool.disconnectAll();
  });

  it('reports readonly profile filtering separately from an empty MCP server', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [{ name: 'git', transportType: 'stdio' }],
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
      }, {}),
      /当前 profile 不允许使用 git 的任何 MCP tool/u,
    );

    await pool.disconnectAll();
  });

  it('filters local file primitive duplicates out of MCP catalog and calls', async () => {
    const pool = createMcpGatewayWarmPool({
      createBundle: async () => ({
        configs: [{ name: 'git', transportType: 'stdio' }],
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

    const catalog = await executeList({ serverName: 'git' }, {});

    assert.deepEqual(catalog, {
      serverName: 'git',
      profile: 'write',
      toolCount: 0,
      tools: [],
      errors: [],
      unavailableReason: 'MCP server git 的本地文件读写/搜索工具已由内置 file primitives 接管。',
    });
    await assert.rejects(
      async () => executeCall({
        serverName: 'git',
        toolName: 'read_file',
        arguments: { path: 'README.md' },
      }, {}),
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
      'sqlite-mcp',
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
    const sqliteMcp = loaded.configs.find((config) => config.name === 'sqlite-mcp');
    const tavily = loaded.configs.find((config) => config.name === 'tavily-mcp');

    assert.equal(git?.command, UVX_FIXTURE_PATH);
    assert.deepEqual(git?.args, ['mcp-server-git==2026.1.14', '--repository', WORKSPACE_ROOT]);
    assert.equal(git?.env?.GIT_PYTHON_GIT_EXECUTABLE, GIT_FIXTURE_PATH);
    assert.equal(probe?.command, 'npx.cmd');
    assert.deepEqual(probe?.args, ['-y', '@probelabs/probe@0.6.0-rc315', 'mcp']);
    assert.equal(memory?.env?.MEMORY_FILE_PATH, MEMORY_FILE_PATH);
    assert.equal(github?.transportType, 'http');
    assert.equal(github?.url, 'https://api.githubcopilot.com/mcp/');
    assert.match(github?.headers?.Authorization ?? '', /^Bearer\s+/u);
    assert.deepEqual(context7?.args, []);
    assert.deepEqual(hooksMcp?.args, ['hooks-mcp==0.2.4', '--working-directory', WORKSPACE_ROOT]);
    assert.equal(sqliteMcp?.env?.SQLITE_DB_PATH, resolve(join(WORKSPACE_ROOT, 'tmp', 'agent-sidecar.sqlite')));
    assert.equal(sqliteMcp?.env?.SQLITE_READ_ONLY, 'true');
    assert.equal(sqliteMcp?.env?.SQLITE_TIMEOUT, '30');
    assert.equal(tavily?.env?.TAVILY_API_KEY, 'tvly-test-key');
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
  it('skips sqlite MCP when database path is missing', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        ...defaultEnv,
        SQLITE_DB_PATH: '',
      },
      platform: 'win32',
    });

    assert.equal(loaded.configs.some((config) => config.name === 'sqlite-mcp'), false);
    assert.equal(loaded.errors.some((error) => /SQLITE_DB_PATH/u.test(error)), true);
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
      'sqlite-mcp',
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
      configuredServers: 9,
      serverNames: [
        'git',
        'probe',
        'memory',
        'sequential-thinking',
        'github',
        'context7',
        'hooks-mcp',
        'sqlite-mcp',
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
});
