import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/bindings/tauri';
import { type ICommandMeta, runCommand } from './core/ipc-define';
import type { IIpcCallOptions } from './core/ipc-types';

export interface IGitHubAuthRequest {
  repositoryRootPath: string;
}

export interface IGitHubBrowserAuthCompleteRequest extends IGitHubAuthRequest {
  state: string;
}

export interface IGitHubAuthStatusPayload {
  authenticated: boolean;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
  email: string | null;
  source: string | null;
  message: string | null;
}

export interface IGitHubBrowserAuthPayload {
  authorizationUrl: string;
  state: string;
  expiresIn: number;
}

const createRequest = (repositoryRootPath: string): IGitHubAuthRequest => ({
  repositoryRootPath,
});

/**
 * GitHub 授权 Tauri 命令的声明式包装元数据表。语义与原手写 callSpectaCommand 逐字段对齐。
 */
const GITHUB_AUTH_COMMAND_META = {
  getGithubAuthStatus: {
    command: 'get_github_auth_status',
    guardHint: '读取 GitHub 登录状态',
    idempotent: true,
    timeoutMs: 15_000,
  },
  beginGithubBrowserAuth: {
    command: 'begin_github_browser_auth',
    guardHint: '发起 GitHub 浏览器授权',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  completeGithubBrowserAuth: {
    command: 'complete_github_browser_auth',
    guardHint: '完成 GitHub 浏览器授权',
    audit: 'sensitive',
    timeoutMs: 200_000,
  },
  connectGithub: {
    command: 'connect_github',
    guardHint: '连接 GitHub 账号',
    audit: 'sensitive',
    timeoutMs: 15_000,
  },
  disconnectGithub: {
    command: 'disconnect_github',
    guardHint: '断开 GitHub 账号',
    audit: 'sensitive',
    timeoutMs: 10_000,
  },
} satisfies Record<string, ICommandMeta>;

export const getGithubAuthStatus = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  runCommand(GITHUB_AUTH_COMMAND_META.getGithubAuthStatus, { repositoryRootPath }, options, () =>
    commands.getGithubAuthStatus(createRequest(repositoryRootPath)),
  );

export const beginGithubBrowserAuth = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubBrowserAuthPayload> =>
  runCommand(GITHUB_AUTH_COMMAND_META.beginGithubBrowserAuth, { repositoryRootPath }, options, () =>
    invoke<IGitHubBrowserAuthPayload>('begin_github_browser_auth', {
      payload: createRequest(repositoryRootPath),
    }),
  );

export const completeGithubBrowserAuth = (
  payload: IGitHubBrowserAuthCompleteRequest,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  runCommand(
    GITHUB_AUTH_COMMAND_META.completeGithubBrowserAuth,
    {
      repositoryRootPath: payload.repositoryRootPath,
      state: payload.state,
    },
    options,
    () => invoke<IGitHubAuthStatusPayload>('complete_github_browser_auth', { payload }),
  );

export const connectGithub = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  runCommand(GITHUB_AUTH_COMMAND_META.connectGithub, { repositoryRootPath }, options, () =>
    commands.connectGithub(createRequest(repositoryRootPath)),
  );

export const disconnectGithub = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  runCommand(GITHUB_AUTH_COMMAND_META.disconnectGithub, { repositoryRootPath }, options, () =>
    commands.disconnectGithub(createRequest(repositoryRootPath)),
  );
