import { callSpectaCommand, invokeTauriCommand } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

export interface IGitHubAuthRequest {
  repositoryRootPath: string;
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

const createRequest = (repositoryRootPath: string): IGitHubAuthRequest => ({
  repositoryRootPath,
});

export const getGithubAuthStatus = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  callSpectaCommand(
    {
      command: 'get_github_auth_status',
      guardHint: '读取 GitHub 登录状态',
      idempotent: true,
      timeoutMs: 15_000,
      input: { repositoryRootPath },
      signal: options?.signal,
    },
    () =>
      invokeTauriCommand<IGitHubAuthStatusPayload>('get_github_auth_status', {
        payload: createRequest(repositoryRootPath),
      }),
  );

export const connectGithub = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  callSpectaCommand(
    {
      command: 'connect_github',
      guardHint: '连接 GitHub 账号',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: { repositoryRootPath },
      signal: options?.signal,
    },
    () =>
      invokeTauriCommand<IGitHubAuthStatusPayload>('connect_github', {
        payload: createRequest(repositoryRootPath),
      }),
  );

export const disconnectGithub = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  callSpectaCommand(
    {
      command: 'disconnect_github',
      guardHint: '断开 GitHub 账号',
      audit: 'sensitive',
      timeoutMs: 10_000,
      input: { repositoryRootPath },
      signal: options?.signal,
    },
    () =>
      invokeTauriCommand<IGitHubAuthStatusPayload>('disconnect_github', {
        payload: createRequest(repositoryRootPath),
      }),
  );
