import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  createMastraMcpClientBundle,
  getMcpRuntimeStatus,
  loadMcpServerConfigs,
} from './mcp.js';

const WORKSPACE_ROOT = resolve('D:/com.xiaojianc/my_desktop_app');
const MEMORY_FILE_PATH = join(WORKSPACE_ROOT, 'tmp', 'mcp-memory-test.jsonl');
const UVX_FIXTURE_PATH = join(tmpdir(), 'xiaojianc-mcp-fixtures', 'uvx.exe');
const GIT_FIXTURE_PATH = join(tmpdir(), 'xiaojianc-mcp-fixtures', 'git.exe');

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

describe('MCP sidecar config', () => {
  it('loads the built-in Anthropic and Tavily MCP servers', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
    });

    assert.deepEqual(loaded.errors, []);
    assert.deepEqual(loaded.configs.map((config) => config.name), [
      'filesystem',
      'git',
      'playwright',
      'probe',
      'memory',
      'sequential-thinking',
      'time',
      'github',
      'context7',
      'logoscope',
      'hooks-mcp',
      'sqlite-mcp',
      'tavily-mcp',
    ]);
  });

  it('wires workspace, memory, time and Tavily settings into server configs', () => {
    const loaded = loadMcpServerConfigs({
      workspaceRootPath: WORKSPACE_ROOT,
      env: {
        ...defaultEnv,
        AGENT_MCP_LOCAL_TIMEZONE: 'Asia/Shanghai',
      },
      platform: 'win32',
    });
    const filesystem = loaded.configs.find((config) => config.name === 'filesystem');
    const git = loaded.configs.find((config) => config.name === 'git');
    const playwright = loaded.configs.find((config) => config.name === 'playwright');
    const probe = loaded.configs.find((config) => config.name === 'probe');
    const memory = loaded.configs.find((config) => config.name === 'memory');
    const time = loaded.configs.find((config) => config.name === 'time');
    const github = loaded.configs.find((config) => config.name === 'github');
    const context7 = loaded.configs.find((config) => config.name === 'context7');
    const logoscope = loaded.configs.find((config) => config.name === 'logoscope');
    const hooksMcp = loaded.configs.find((config) => config.name === 'hooks-mcp');
    const sqliteMcp = loaded.configs.find((config) => config.name === 'sqlite-mcp');
    const tavily = loaded.configs.find((config) => config.name === 'tavily-mcp');

    assert.ok(filesystem?.args);
    assert.equal(filesystem.args[0], WORKSPACE_ROOT);
    assert.equal(git?.command, UVX_FIXTURE_PATH);
    assert.deepEqual(git?.args, ['mcp-server-git==2026.1.14', '--repository', WORKSPACE_ROOT]);
    assert.equal(git?.env?.GIT_PYTHON_GIT_EXECUTABLE, GIT_FIXTURE_PATH);
    assert.deepEqual(playwright?.args, ['--headless']);
    assert.equal(probe?.command, 'npx.cmd');
    assert.deepEqual(probe?.args, ['-y', '@probelabs/probe@0.6.0-rc315', 'mcp']);
    assert.equal(memory?.env?.MEMORY_FILE_PATH, MEMORY_FILE_PATH);
    assert.equal(time?.command, UVX_FIXTURE_PATH);
    assert.deepEqual(time?.args, ['mcp-server-time==2026.1.26', '--local-timezone=Asia/Shanghai']);
    assert.equal(github?.transportType, 'http');
    assert.equal(github?.url, 'https://api.githubcopilot.com/mcp/');
    assert.match(github?.headers?.Authorization ?? '', /^Bearer\s+/u);
    assert.deepEqual(context7?.args, []);
    assert.deepEqual(logoscope?.args, ['mcp']);
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
      'filesystem',
      'git',
      'playwright',
      'probe',
      'memory',
      'sequential-thinking',
      'time',
      'github',
      'context7',
      'logoscope',
      'hooks-mcp',
      'sqlite-mcp',
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
      configuredServers: 13,
      serverNames: [
        'filesystem',
        'git',
        'playwright',
        'probe',
        'memory',
        'sequential-thinking',
        'time',
        'github',
        'context7',
        'logoscope',
        'hooks-mcp',
        'sqlite-mcp',
        'tavily-mcp',
      ],
      errors: [],
    });
  });

  it('builds a Mastra-ready MCP bundle from the official SDK and keeps healthy tools when one configured server closes', async () => {
    const bundle = await createMastraMcpClientBundle({
      workspaceRootPath: WORKSPACE_ROOT,
      env: defaultEnv,
      platform: 'win32',
    });

    try {
      const readFileTool = bundle.tools.find((tool) => tool.name === 'read_file');
      const sequentialThinkingTool = bundle.tools.find((tool) => tool.name === 'sequentialthinking');

      assert.ok(readFileTool);
      assert.ok(sequentialThinkingTool);
      assert.equal(typeof readFileTool.mcpClient.callTool, 'function');
      assert.equal(typeof readFileTool.toolSpec.inputSchema, 'object');
      assert.equal(
        bundle.errors.some((error) => error.includes('git') || error.includes('time')),
        true,
      );
    } finally {
      await bundle.disconnectAll();
    }
  });
});
