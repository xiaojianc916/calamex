import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/bindings/tauri';
import { callSpectaCommand } from './tauri.ipc-runtime';
import type { IIpcCallOptions } from './tauri.ipc-types';

export interface IGitHubAuthRequest {
  repositoryRootPath: string;
}

export interface IGitHubBrowserAuthCompleteRequest extends IGitHubAuthRequest {
  state: string;
}

export interface IGitHubDeviceAuthCompleteRequest extends IGitHubAuthRequest {
  deviceCode: string;
  interval: number;
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

export interface IGitHubDeviceAuthPayload {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
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
    () => commands.getGithubAuthStatus(createRequest(repositoryRootPath)),
  );

export const beginGithubBrowserAuth = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubBrowserAuthPayload> =>
  callSpectaCommand(
    {
      command: 'begin_github_browser_auth',
      guardHint: '发起 GitHub 浏览器授权',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: { repositoryRootPath },
      signal: options?.signal,
    },
    () =>
      invoke<IGitHubBrowserAuthPayload>('begin_github_browser_auth', {
        payload: createRequest(repositoryRootPath),
      }),
  );

export const completeGithubBrowserAuth = (
  payload: IGitHubBrowserAuthCompleteRequest,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  callSpectaCommand(
    {
      command: 'complete_github_browser_auth',
      guardHint: '完成 GitHub 浏览器授权',
      audit: 'sensitive',
      timeoutMs: 200_000,
      input: {
        repositoryRootPath: payload.repositoryRootPath,
        state: payload.state,
      },
      signal: options?.signal,
    },
    () => invoke<IGitHubAuthStatusPayload>('complete_github_browser_auth', { payload }),
  );

export const beginGithubDeviceAuth = (
  repositoryRootPath: string,
  options?: IIpcCallOptions,
): Promise<IGitHubDeviceAuthPayload> =>
  callSpectaCommand(
    {
      command: 'begin_github_device_auth',
      guardHint: '发起 GitHub 设备授权',
      audit: 'sensitive',
      timeoutMs: 15_000,
      input: { repositoryRootPath },
      signal: options?.signal,
    },
    () => commands.beginGithubDeviceAuth(createRequest(repositoryRootPath)),
  );

export const completeGithubDeviceAuth = (
  payload: IGitHubDeviceAuthCompleteRequest,
  options?: IIpcCallOptions,
): Promise<IGitHubAuthStatusPayload> =>
  callSpectaCommand(
    {
      command: 'complete_github_device_auth',
      guardHint: '完成 GitHub 设备授权',
      audit: 'sensitive',
      timeoutMs: 140_000,
      input: {
        repositoryRootPath: payload.repositoryRootPath,
        interval: payload.interval,
      },
      signal: options?.signal,
    },
    () => commands.completeGithubDeviceAuth(payload),
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
    () => commands.connectGithub(createRequest(repositoryRootPath)),
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
    () => commands.disconnectGithub(createRequest(repositoryRootPath)),
  );
