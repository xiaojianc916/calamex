import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolsInput } from '@mastra/core/agent';
import {
  MCPClient,
  type LogMessage,
  type MastraMCPServerDefinition
} from '@mastra/mcp';
import { withTimeout, withTimeoutFallback } from '../timeout.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types

/**
 * MCP server 配置；transportType 区分 stdio / http，对应字段在各分支下变必填。
 */
export type IMcpServerConfig =
  | {
    name: string;
    transportType: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string | null;
  }
  | {
    name: string;
    transportType: 'http';
    url: string;
    headers?: Record<string, string>;
  };

export interface IMastraMcpClientBundle {
  client: MCPClient | null;
  configs: IMcpServerConfig[];
  errors: string[];
  tools: ToolsInput;
  disconnectAll: () => Promise<void>;
}

export interface IMcpRuntimeStatus {
  configuredServers: number;
  serverNames: string[];
  errors: string[];
}

export const MCP_SERVER_NAMES = [
  'git',
  'probe',
  'memory',
  'sequential-thinking',
  'github',
  'context7',
  'logoscope',
  'hooks-mcp',
  'sqlite-mcp',
  'tavily-mcp',
] as const;

export type TMcpServerName = typeof MCP_SERVER_NAMES[number];

export interface IMcpConfigOptions {
  workspaceRootPath?: string | null;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  serverNames?: readonly TMcpServerName[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants

const SIDECAR_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const PROJECT_ROOT = resolve(SIDECAR_ROOT, '..');
const NODE_BIN_DIRECTORY = join(SIDECAR_ROOT, 'node_modules', '.bin');

const DEFAULT_MEMORY_FILE_PATH = join(homedir(), '.xiaojianc', 'mcp-memory.jsonl');
const DEFAULT_GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

/** 第三方 MCP 包版本统一管理；升级时改这里一处。 */
const MCP_PACKAGE_SPECS = {
  mcpServerGit: 'mcp-server-git==2026.1.14',
  hooksMcp: 'hooks-mcp==0.2.4',
  sqliteMcp: 'sqlite-mcp==0.1.0',
  probe: '@probelabs/probe@0.6.0-rc315', // NOTE: pre-release；首次启动需联网拉包
} as const;

/** MCPClient 单次 RPC 超时（listTools 之外的常规调用）。 */
const MCP_RPC_TIMEOUT_MS = 10_000;
/** 启动时 listTools 超时（包含 spawn + 握手，通常比常规 RPC 慢）。 */
const MCP_LIST_TOOLS_TIMEOUT_MS = 30_000;
/** disconnect 超时；超过则放弃等待。 */
const MCP_DISCONNECT_TIMEOUT_MS = 5_000;
/** 每个 MCP server 最多收集多少条 error 进 errors[]，超过丢弃。 */
const MCP_RUNTIME_ERROR_LIMIT_PER_SERVER = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

const trimToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const resolveWorkspaceRoot = (workspaceRootPath: string | null | undefined): string =>
  resolve(trimToNull(workspaceRootPath) ?? PROJECT_ROOT);

const shouldLoadServer = (
  requestedServers: ReadonlySet<TMcpServerName> | null,
  serverName: TMcpServerName,
): boolean => !requestedServers || requestedServers.has(serverName);

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

const appendMcpRuntimeError = (
  errors: string[],
  knownMessages: Set<string>,
  serverErrorCounts: Map<string, number>,
  logMessage: LogMessage,
): void => {
  if (logMessage.level !== 'error') {
    return;
  }
  const currentCount = serverErrorCounts.get(logMessage.serverName) ?? 0;
  if (currentCount >= MCP_RUNTIME_ERROR_LIMIT_PER_SERVER) {
    return;
  }
  const message = `MCP server ${logMessage.serverName} 不可用，已跳过：${logMessage.message}`;
  if (knownMessages.has(message)) {
    return;
  }
  knownMessages.add(message);
  errors.push(message);
  serverErrorCounts.set(logMessage.serverName, currentCount + 1);
};

const toMastraMcpServerDefinition = (
  config: IMcpServerConfig,
  errors: string[],
  knownMessages: Set<string>,
  serverErrorCounts: Map<string, number>,
): MastraMCPServerDefinition | null => {
  const logger = (message: LogMessage): void =>
    appendMcpRuntimeError(errors, knownMessages, serverErrorCounts, message);
  if (config.transportType === 'http') {
    const url = trimToNull(config.url);
    if (!url) {
      errors.push(`MCP server ${config.name} 缺少 URL，已跳过。`);
      return null;
    }
    return {
      url: new URL(url),
      logger,
      // 使用官方 MCPClient 的 requestInit 支持传入 headers（例如 Authorization）
      ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
    };
  }
  const command = trimToNull(config.command);
  if (!command) {
    errors.push(`MCP server ${config.name} 缺少启动命令，已跳过。`);
    return null;
  }
  return {
    command,
    ...(config.args ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    logger,
    // 'ignore' 避免 stderr pipe buffer 占满后子进程 write() 阻塞导致死锁。
    // 如确认 MCPClient 内部已消费 stderr，可改回 'pipe' 以保留诊断信息。
    stderr: 'ignore',
  };
};

const createMastraMcpServers = (
  configs: IMcpServerConfig[],
  errors: string[],
): Record<string, MastraMCPServerDefinition> => {
  const knownMessages = new Set(errors);
  const serverErrorCounts = new Map<string, number>();
  const result: Record<string, MastraMCPServerDefinition> = {};
  for (const config of configs) {
    if (Object.prototype.hasOwnProperty.call(result, config.name)) {
      errors.push(`MCP server 名称重复：${config.name}，已忽略后续配置。`);
      continue;
    }
    const server = toMastraMcpServerDefinition(config, errors, knownMessages, serverErrorCounts);
    if (server) {
      result[config.name] = server;
    }
  }
  return result;
};

// ─────────────────────────────────────────────────────────────────────────────
// Public surface

export const loadMcpServerConfigs = (
  options: IMcpConfigOptions = {},
): { configs: IMcpServerConfig[]; errors: string[] } => {
  const env = normalizeEnv(options.env);
  const platform = options.platform ?? process.platform;
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRootPath);
  const errors: string[] = [];
  const configs: IMcpServerConfig[] = [];
  const requestedServers = options.serverNames
    ? new Set(options.serverNames)
    : null;

  const uvxCommand = resolveWindowsUvxCommand(env, platform);
  const npxCommand = resolveNpxCommand(platform);
  const gitExecutable = resolveWindowsGitExecutable(env, platform);
  const memoryFilePath = resolve(trimToNull(env.AGENT_MCP_MEMORY_FILE_PATH) ?? DEFAULT_MEMORY_FILE_PATH);
  const githubMcpPat = trimToNull(env.GITHUB_MCP_PAT);
  const githubMcpUrl = trimToNull(env.GITHUB_MCP_URL) ?? DEFAULT_GITHUB_MCP_URL;
  const sqliteDbPath = trimToNull(env.SQLITE_DB_PATH);

  if (!shouldLoadServer(requestedServers, 'git')) {
    // 当前请求不需要 Git MCP。
  } else if (uvxCommand && gitExecutable) {
    configs.push({
      name: 'git',
      transportType: 'stdio',
      command: uvxCommand,
      args: [MCP_PACKAGE_SPECS.mcpServerGit, '--repository', workspaceRoot],
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

  if (shouldLoadServer(requestedServers, 'probe')) {
    configs.push({
      name: 'probe',
      transportType: 'stdio',
      command: npxCommand,
      args: ['-y', MCP_PACKAGE_SPECS.probe, 'mcp'],
      env: {},
      cwd: workspaceRoot,
    });
  }

  if (shouldLoadServer(requestedServers, 'memory') && ensureParentDirectory(memoryFilePath, errors)) {
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

  if (shouldLoadServer(requestedServers, 'sequential-thinking')) {
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
  }

  if (!shouldLoadServer(requestedServers, 'github')) {
    // 当前请求不需要 GitHub MCP。
  } else if (githubMcpPat) {
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

  if (shouldLoadServer(requestedServers, 'context7')) {
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
  }

  if (shouldLoadServer(requestedServers, 'logoscope')) {
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
  }

  if (shouldLoadServer(requestedServers, 'hooks-mcp')) {
    const hooksMcp = uvxServerConfig(
      'hooks-mcp',
      uvxCommand,
      MCP_PACKAGE_SPECS.hooksMcp,
      ['--working-directory', workspaceRoot],
      workspaceRoot,
      errors,
      '未找到 Windows uvx.exe 绝对路径，已跳过 hooks-mcp。请设置 AGENT_MCP_UVX_PATH。',
    );
    if (hooksMcp) {
      configs.push(hooksMcp);
    }
  }

  if (!shouldLoadServer(requestedServers, 'sqlite-mcp')) {
    // 当前请求不需要 SQLite MCP。
  } else if (sqliteDbPath) {
    const sqlite = uvxServerConfig(
      'sqlite-mcp',
      uvxCommand,
      MCP_PACKAGE_SPECS.sqliteMcp,
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
  if (!shouldLoadServer(requestedServers, 'tavily-mcp')) {
    // 当前请求不需要 Tavily MCP。
  } else if (tavilyApiKey) {
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
  const servers = createMastraMcpServers(configs, errors);
  let client: MCPClient | null = null;
  let tools: ToolsInput = {};

  try {
    client = Object.keys(servers).length > 0
      ? new MCPClient({
        id: `xiaojianc-agent-sidecar-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        servers,
        timeout: MCP_RPC_TIMEOUT_MS,
      })
      : null;

    if (client) {
      try {
        tools = await withTimeout(
          client.listTools(),
          MCP_LIST_TOOLS_TIMEOUT_MS,
          () => new Error(`MCP listTools 超过 ${MCP_LIST_TOOLS_TIMEOUT_MS}ms 未完成`),
        );
      } catch (error) {
        errors.push(`MCP listTools 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    if (client) {
      await client.disconnect().catch(() => undefined);
    }
    throw error;
  }

  const disconnectAll = async (): Promise<void> => {
    if (!client) {
      return;
    }
    try {
      await withTimeoutFallback(client.disconnect(), MCP_DISCONNECT_TIMEOUT_MS, undefined);
    } catch (error) {
      console.warn(`[mcp] disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    client,
    configs,
    errors,
    tools,
    disconnectAll,
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
