import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/types/app-error';
import { tauriService } from './index';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: typeof invoke;
    };
  }
}

describe('tauriService', () => {
  const invokeMock = vi.mocked(invoke);

  beforeEach(() => {
    invokeMock.mockReset();
    window.__TAURI_INTERNALS__ = {
      invoke: invokeMock,
    };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__TAURI_INTERNALS__;
  });

  it('loadScript 驱动扁平参数命令', async () => {
    invokeMock.mockResolvedValue({
      path: 'D:/demo.sh',
      name: 'demo.sh',
      content: 'echo test',
      encoding: 'utf-8',
      lineCount: 1,
      charCount: 9,
    });

    await expect(tauriService.loadScript('D:/demo.sh')).resolves.toMatchObject({
      path: 'D:/demo.sh',
      name: 'demo.sh',
    });
    expect(invokeMock).toHaveBeenCalledWith('load_script', {
      path: 'D:/demo.sh',
      workspaceRootPath: null,
    });
  });

  it('归一化后的错误保持为 AppError', async () => {
    invokeMock.mockRejectedValue(new Error('boom'));

    let caughtError: unknown;
    try {
      await tauriService.detectEnvironment();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AppError);
  });

  it('Workspace 文件读取支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const loadScript = tauriService.loadScript as unknown as (
      path: string,
      workspaceRootPath?: string | null,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    await expect(
      loadScript('D:/repo/demo.sh', 'D:/repo', { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Workspace 目录读取支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const listEntries = tauriService.listWorkspaceEntries as unknown as (
      path?: string,
      rootPath?: string,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    await expect(
      listEntries(undefined, 'D:/repo', { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Workspace 替换应用支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const applyReplacement = tauriService.applyWorkspaceReplacement as unknown as (
      payload: Parameters<typeof tauriService.applyWorkspaceReplacement>[0],
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    await expect(
      applyReplacement(
        {
          request: {
            workspaceRootPath: 'D:/repo',
            query: 'old',
            replacement: 'new',
            matchCase: false,
            wholeWord: false,
            useRegex: false,
            includePatterns: [],
            excludePatterns: [],
          },
          expectedFiles: [],
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Git 仓库状态支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const getStatus = tauriService.getGitRepositoryStatus as unknown as (
      workspaceRootPath?: string | null,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    await expect(getStatus('D:/repo', { signal: controller.signal })).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Git 危险变更操作支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const discardPaths = tauriService.discardGitPaths as unknown as (
      payload: Parameters<typeof tauriService.discardGitPaths>[0],
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    await expect(
      discardPaths(
        {
          repositoryRootPath: 'D:/repo',
          paths: ['D:/repo/demo.sh'],
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('SSH 配置主机列表支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const listHosts = tauriService.listSshConfigHosts as unknown as (options?: {
      signal?: AbortSignal;
    }) => Promise<unknown>;

    await expect(listHosts({ signal: controller.signal })).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('SSH 目录读取支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const listDirectory = tauriService.listSshDirectory as unknown as (
      payload: Parameters<typeof tauriService.listSshDirectory>[0],
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

    await expect(
      listDirectory(
        {
          host: 'example.com',
          port: 22,
          username: 'root',
          authMode: 'password',
          identityPath: null,
          password: 'password',
          path: '.',
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('agentSidecarRestoreCheckpoint 复用 sidecar 长任务超时预算并透传 payload', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(() => new Promise(() => undefined));

    try {
      const sidecarTaskTimeoutMs = 30 * 60 * 1000;
      const promise = tauriService.agentSidecarRestoreCheckpoint({
        runId: 'run-1',
        snapshotId: 'snapshot-1',
        step: ['durable-agentic-execution', 'durable-llm-execution'],
      });

      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.advanceTimersByTimeAsync(sidecarTaskTimeoutMs);
      await expect(promise).rejects.toMatchObject({
        code: 'ipc.timeout',
        scope: 'ipc',
      });
      expect(invokeMock).toHaveBeenCalledWith('builtin_agent_restore_checkpoint', {
        payload: {
          runId: 'run-1',
          snapshotId: 'snapshot-1',
          step: ['durable-agentic-execution', 'durable-llm-execution'],
        },
      });
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agentSidecarRestart invokes the restart command and validates health payload', async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      status: 'ready',
      engine: 'mastra',
      version: null,
      protocolVersion: '7',
      implementationVersion: 'deepseek-reasoning-transport-v6-plan-history',
      mcp: {
        configuredServers: 0,
        serverNames: [],
        errors: [],
      },
    });

    await expect(tauriService.agentSidecarRestart()).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      engine: 'mastra',
    });
    expect(invokeMock).toHaveBeenCalledWith('builtin_agent_restart');
  });
});
