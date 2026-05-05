import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface IMcpServerConfig {
  name: string;
  transportType: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  url?: string;
  headers?: Record<string, string>;
}

export interface IMastraMcpTool {
  name: string;
  description: string;
  toolSpec: {
    inputSchema?: unknown;
    outputSchema?: unknown;
  };
  mcpClient: {
    callTool: (targetTool: unknown, args: Record<string, unknown>) => Promise<unknown>;
  };
}

export interface IMastraMcpClientBundle {
  clients: Client[];
  configs: IMcpServerConfig[];
  errors: string[];
  tools: IMastraMcpTool[];
  disconnectAll: () => Promise<void>;
}

export interface IMcpRuntimeStatus {
  configuredServers: number;
  serverNames: string[];
  errors: string[];
}

export interface IMcpConfigOptions {
  workspaceRootPath?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

const SIDECAR_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PROJECT_ROOT = resolve(SIDECAR_ROOT, '..');
const NODE_BIN_DIRECTORY = join(SIDECAR_ROOT, 'node_modules', '.bin');
const DEFAULT_MEMORY_FILE_PATH = join(homedir(), '.xiaojianc', 'mcp-memory.jsonl');
const DEFAULT_LOCAL_TIMEZONE = 'Asia/Shanghai';
const DEFAULT_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const PROBE_MCP_NPX_SPEC = '@probelabs/probe@0.6.0-rc315';
const MCP_LIST_TOOLS_TIMEOUT_MS = 10_000;
const MCP_STDERR_SUMMARY_LIMIT = 1_000;

type TMcpSdkTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type TMcpTransport = StreamableHTTPClientTransport | StdioClientTransport;

const trimToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
};

const resolveWorkspaceRoot = (workspaceRootPath: string | null | undefined): string =>
  resolve(trimToNull(workspaceRootPath) ?? PROJECT_ROOT);

const normalizeEnv = (
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> => env ?? process.env;

const localBinPath = (name: string, platform: NodeJS.Platform): string =>
  join(NODE_BIN_DIRECTORY, platform === 'win32' ? `${name}.CMD` : name);

const ensureParentDirectory = (filePath: string, errors: string[]): boolean => {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    return true;
  } catch (error) {
    errors.push(`Memory MCP 存储目录创建失败：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
};

const resolveNodeServerCommand = (
  binName: string,
  platform: NodeJS.Platform,
  errors: string[],
): string | null => {
  const command = localBinPath(binName, platform);

  if (existsSync(command)) {
    return command;
  }

  errors.push(`MCP server 可执行文件不存在：${command}`);
  return null;
};

const normalizeAbsoluteExecutablePath = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const normalized = resolve(value);
  return existsSync(normalized) ? normalized : null;
};

const resolveNpxCommand = (platform: NodeJS.Platform): string =>
  platform === 'win32' ? 'npx.cmd' : 'npx';

const resolveWindowsUvxCommand = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null => {
  const configured = normalizeAbsoluteExecutablePath(trimToNull(env.AGENT_MCP_UVX_PATH));
  if (configured) {
    return configured;
  }

  if (platform !== 'win32') {
    return null;
  }

  const candidates = [
    join(trimToNull(env.USERPROFILE) ?? '', '.local', 'bin', 'uvx.exe'),
    join(trimToNull(env.USERPROFILE) ?? '', '.cargo', 'bin', 'uvx.exe'),
    join(trimToNull(env.LOCALAPPDATA) ?? '', 'Programs', 'uv', 'uvx.exe'),
    join(trimToNull(env.LOCALAPPDATA) ?? '', 'uv', 'uvx.exe'),
    join(trimToNull(env.ProgramFiles) ?? '', 'uv', 'uvx.exe'),
    join(trimToNull(env['ProgramFiles(x86)']) ?? '', 'uv', 'uvx.exe'),
  ];

  for (const candidate of candidates) {
    const resolved = normalizeAbsoluteExecutablePath(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
};

const resolveWindowsGitExecutable = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null => {
  const configured = normalizeAbsoluteExecutablePath(trimToNull(env.AGENT_MCP_GIT_EXECUTABLE_PATH));
  if (configured) {
    return configured;
  }

  if (platform !== 'win32') {
    return null;
  }

  const programFiles = trimToNull(env.ProgramFiles) ?? 'C:\\Program Files';
  const programFilesX86 = trimToNull(env['ProgramFiles(x86)']) ?? 'C:\\Program Files (x86)';
  const localAppData = trimToNull(env.LOCALAPPDATA);
  const candidates = [
    join(programFiles, 'Git', 'cmd', 'git.exe'),
    join(programFiles, 'Git', 'bin', 'git.exe'),
    join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    join(programFilesX86, 'Git', 'bin', 'git.exe'),
    localAppData ? join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe') : '',
    localAppData ? join(localAppData, 'Programs', 'Git', 'bin', 'git.exe') : '',
  ];

  for (const candidate of candidates) {
    const resolved = normalizeAbsoluteExecutablePath(candidate);
    if (resolved) {
      return resolved;
    }
  }

  return null;
};

const nodeServerConfig = (
  name: string,
  binName: string,
  args: string[],
  workspaceRoot: string,
  platform: NodeJS.Platform,
  errors: string[],
  env: Record<string, string> = {},
): IMcpServerConfig | null => {
  const command = resolveNodeServerCommand(binName, platform, errors);
  if (!command) {
    return null;
  }

  return {
    name,
    transportType: 'stdio',
    command,
    args,
    env,
    cwd: workspaceRoot,
  };
};

const uvxServerConfig = (
  name: string,
  uvxCommand: string | null,
  uvxPackageSpec: string,
  args: string[],
  workspaceRoot: string,
  errors: string[],
  missingUvxError: string,
  env: Record<string, string> = {},
): IMcpServerConfig | null => {
  if (!uvxCommand) {
    errors.push(missingUvxError);
    return null;
  }

  return {
    name,
    transportType: 'stdio',
    command: uvxCommand,
    args: [uvxPackageSpec, ...args],
    env,
    cwd: workspaceRoot,
  };
};

const truncateForStatus = (value: string): string => {
  const trimmed = value.trim();

  return trimmed.length > MCP_STDERR_SUMMARY_LIMIT
    ? `${trimmed.slice(0, MCP_STDERR_SUMMARY_LIMIT)}...`
    : trimmed;
};

const withTimeout = async <T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    task.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const formatMcpError = (config: IMcpServerConfig, error: unknown, stderrText: string): string => {
  const message = error instanceof Error ? error.message : String(error);
  const stderrSummary = truncateForStatus(stderrText);

  return stderrSummary
    ? `MCP server ${config.name} 不可用，已跳过：${message}；stderr：${stderrSummary}`
    : `MCP server ${config.name} 不可用，已跳过：${message}`;
};

const toCallToolArguments = (value: unknown): Record<string, unknown> => {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error('MCP tool 参数必须是对象。');
};

const createMcpTransport = (
  config: IMcpServerConfig,
  safeBaseEnv: Record<string, string>,
): { transport: TMcpTransport; stderrText: () => string } => {
  let stderrBuffer = '';
  let transport: TMcpTransport;

  if (config.transportType === 'http') {
    transport = new StreamableHTTPClientTransport(new URL(config.url ?? DEFAULT_GITHUB_MCP_URL), {
      ...(config.headers ? {
        requestInit: {
          headers: config.headers,
        },
      } : {}),
    });
  } else {
    const stdioTransport = new StdioClientTransport({
      command: config.command ?? '',
      args: config.args ?? [],
      env: {
        ...safeBaseEnv,
        ...(config.env ?? {}),
      },
      ...(config.cwd ? { cwd: config.cwd } : {}),
      stderr: 'pipe',
    });

    stdioTransport.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
    });

    transport = stdioTransport;
  }

  return {
    transport,
    stderrText: () => stderrBuffer,
  };
};

const createMastraMcpClient = (
  config: IMcpServerConfig,
  safeBaseEnv: Record<string, string>,
): {
  client: Client;
  connect: () => Promise<void>;
  stderrText: () => string;
} => {
  const { transport, stderrText } = createMcpTransport(config, safeBaseEnv);
  const client = new Client({
    name: 'xiaojianc-agent-sidecar',
    version: '0.1.0',
  });

  return {
    client,
    connect: async (): Promise<void> => client.connect(transport as Transport),
    stderrText,
  };
};

const createMastraMcpTool = (
  tool: TMcpSdkTool,
  client: Client,
): IMastraMcpTool => ({
  name: tool.name,
  description: tool.description ?? '',
  toolSpec: {
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  },
  mcpClient: {
    callTool: async (_targetTool: unknown, args: Record<string, unknown>): Promise<unknown> => client.callTool({
      name: tool.name,
      arguments: toCallToolArguments(args),
    }),
  },
});

export const loadMcpServerConfigs = (
  options: IMcpConfigOptions = {},
): { configs: IMcpServerConfig[]; errors: string[] } => {
  const env = normalizeEnv(options.env);
  const platform = options.platform ?? process.platform;
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRootPath);
  const errors: string[] = [];
  const configs: IMcpServerConfig[] = [];
  const uvxCommand = resolveWindowsUvxCommand(env, platform);
  const npxCommand = resolveNpxCommand(platform);
  const gitExecutable = resolveWindowsGitExecutable(env, platform);
  const memoryFilePath = resolve(trimToNull(env.AGENT_MCP_MEMORY_FILE_PATH) ?? DEFAULT_MEMORY_FILE_PATH);
  const localTimezone = trimToNull(env.AGENT_MCP_LOCAL_TIMEZONE) ?? DEFAULT_LOCAL_TIMEZONE;
  const githubMcpPat = trimToNull(env.GITHUB_MCP_PAT);
  const githubMcpUrl = trimToNull(env.GITHUB_MCP_URL) ?? DEFAULT_GITHUB_MCP_URL;
  const sqliteDbPath = trimToNull(env.SQLITE_DB_PATH);

  const filesystem = nodeServerConfig(
    'filesystem',
    'mcp-server-filesystem',
    [workspaceRoot],
    workspaceRoot,
    platform,
    errors,
  );
  if (filesystem) {
    configs.push(filesystem);
  }

  if (uvxCommand && gitExecutable) {
    configs.push({
      name: 'git',
      transportType: 'stdio',
      command: uvxCommand,
      args: ['mcp-server-git==2026.1.14', '--repository', workspaceRoot],
      env: {
        GIT_PYTHON_GIT_EXECUTABLE: gitExecutable,
      },
      cwd: workspaceRoot,
    });
  } else if (!gitExecutable) {
    errors.push('未找到 Windows git.exe 绝对路径，已跳过 Git MCP。请设置 AGENT_MCP_GIT_EXECUTABLE_PATH。');
  } else {
    errors.push('未找到 Windows uvx.exe 绝对路径，已跳过 Git MCP。请设置 AGENT_MCP_UVX_PATH。');
  }

  const playwright = nodeServerConfig(
    'playwright',
    'playwright-mcp',
    ['--headless'],
    workspaceRoot,
    platform,
    errors,
  );
  if (playwright) {
    configs.push(playwright);
  }

  configs.push({
    name: 'probe',
    transportType: 'stdio',
    command: npxCommand,
    args: ['-y', PROBE_MCP_NPX_SPEC, 'mcp'],
    env: {},
    cwd: workspaceRoot,
  });

  if (ensureParentDirectory(memoryFilePath, errors)) {
    const memory = nodeServerConfig(
      'memory',
      'mcp-server-memory',
      [],
      workspaceRoot,
      platform,
      errors,
      {
        MEMORY_FILE_PATH: memoryFilePath,
      },
    );
    if (memory) {
      configs.push(memory);
    }
  }

  const sequentialThinking = nodeServerConfig(
    'sequential-thinking',
    'mcp-server-sequential-thinking',
    [],
    workspaceRoot,
    platform,
    errors,
  );
  if (sequentialThinking) {
    configs.push(sequentialThinking);
  }

  if (uvxCommand) {
    const time = uvxServerConfig(
      'time',
      uvxCommand,
      'mcp-server-time==2026.1.26',
      [`--local-timezone=${localTimezone}`],
      workspaceRoot,
      errors,
      '未找到 Windows uvx.exe 绝对路径，已跳过 Time MCP。请设置 AGENT_MCP_UVX_PATH。',
    );
    if (time) {
      configs.push(time);
    }
  } else {
    errors.push('未找到 Windows uvx.exe 绝对路径，已跳过 Time MCP。请设置 AGENT_MCP_UVX_PATH。');
  }

  if (githubMcpPat) {
    configs.push({
      name: 'github',
      transportType: 'http',
      url: githubMcpUrl,
      headers: {
        Authorization: `Bearer ${githubMcpPat}`,
      },
    });
  } else {
    errors.push('GITHUB_MCP_PAT 未配置，已跳过 github-mcp-server。');
  }

  const context7 = nodeServerConfig(
    'context7',
    'context7-mcp',
    [],
    workspaceRoot,
    platform,
    errors,
  );
  if (context7) {
    configs.push(context7);
  }

  const logoscope = nodeServerConfig(
    'logoscope',
    'logoscope',
    ['mcp'],
    workspaceRoot,
    platform,
    errors,
  );
  if (logoscope) {
    configs.push(logoscope);
  }

  const hooksMcp = uvxServerConfig(
    'hooks-mcp',
    uvxCommand,
    'hooks-mcp==0.2.4',
    ['--working-directory', workspaceRoot],
    workspaceRoot,
    errors,
    '未找到 Windows uvx.exe 绝对路径，已跳过 hooks-mcp。请设置 AGENT_MCP_UVX_PATH。',
  );
  if (hooksMcp) {
    configs.push(hooksMcp);
  }

  if (sqliteDbPath) {
    const sqlite = uvxServerConfig(
      'sqlite-mcp',
      uvxCommand,
      'sqlite-mcp==0.1.0',
      [],
      workspaceRoot,
      errors,
      '未找到 Windows uvx.exe 绝对路径，已跳过 sqlite-mcp。请设置 AGENT_MCP_UVX_PATH。',
      {
        SQLITE_DB_PATH: resolve(sqliteDbPath),
        SQLITE_READ_ONLY: trimToNull(env.SQLITE_READ_ONLY) ?? 'true',
        SQLITE_TIMEOUT: trimToNull(env.SQLITE_TIMEOUT) ?? '30',
      },
    );
    if (sqlite) {
      configs.push(sqlite);
    }
  } else {
    errors.push('SQLITE_DB_PATH 未配置，已跳过 sqlite-mcp。');
  }

  const tavilyApiKey = trimToNull(env.TAVILY_API_KEY);
  if (tavilyApiKey) {
    const tavily = nodeServerConfig(
      'tavily-mcp',
      'tavily-mcp',
      [],
      workspaceRoot,
      platform,
      errors,
      {
        TAVILY_API_KEY: tavilyApiKey,
      },
    );
    if (tavily) {
      configs.push(tavily);
    }
  } else {
    errors.push('TAVILY_API_KEY 未配置，已跳过 tavily-mcp。');
  }

  return {
    configs,
    errors,
  };
};

export const createMastraMcpClientBundle = async (
  options: IMcpConfigOptions = {},
): Promise<IMastraMcpClientBundle> => {
  const { configs, errors } = loadMcpServerConfigs(options);
  const clients: Client[] = [];
  const tools: IMastraMcpTool[] = [];
  const safeBaseEnv = getDefaultEnvironment();

  await Promise.all(configs.map(async (config) => {
    const { client, connect, stderrText } = createMastraMcpClient(config, safeBaseEnv);

    try {
      await withTimeout(
        connect(),
        MCP_LIST_TOOLS_TIMEOUT_MS,
        `MCP server ${config.name} connect 超时`,
      );
      const { tools: clientTools } = await withTimeout(
        client.listTools(),
        MCP_LIST_TOOLS_TIMEOUT_MS,
        `MCP server ${config.name} listTools 超时`,
      );

      clients.push(client);
      tools.push(...clientTools.map((tool) => createMastraMcpTool(tool, client)));
    } catch (error) {
      errors.push(formatMcpError(config, error, stderrText()));
      await client.close().catch(() => undefined);
    }
  }));

  return {
    clients,
    configs,
    errors,
    tools,
    disconnectAll: async (): Promise<void> => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
};

export const getMcpRuntimeStatus = (options: IMcpConfigOptions = {}): IMcpRuntimeStatus => {
  const { configs, errors } = loadMcpServerConfigs(options);

  return {
    configuredServers: configs.length,
    serverNames: configs.map((config) => config.name),
    errors,
  };
};
