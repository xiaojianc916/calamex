import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '@/types/app-error';
import { defineIpc, tauriService } from './tauri';
import { zTauriVoid } from './tauri.contracts';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: typeof invoke;
    };
  }
}

describe('defineIpc', () => {
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

  it('成功路径：返回经过 schema 校验的结果', async () => {
    invokeMock.mockResolvedValue({ ok: true, value: 'done' });

    const call = defineIpc({
      name: 'demo_success',
      guardHint: '演示成功',
      inSchema: z.object({ value: z.string() }),
      outSchema: z.object({ ok: z.boolean(), value: z.string() }),
      mapArgs: (payload) => ({ payload }),
    });

    await expect(call({ value: 'input' })).resolves.toEqual({ ok: true, value: 'done' });
    expect(invokeMock).toHaveBeenCalledWith('demo_success', {
      payload: { value: 'input' },
    });
  });

  it('入参校验失败时不调用 invoke', async () => {
    const call = defineIpc({
      name: 'demo_input_validation',
      guardHint: '演示入参校验',
      inSchema: z.object({ count: z.number().int().min(1) }),
      outSchema: z.object({ ok: z.boolean() }),
    });

    await expect(call({ count: 0 })).rejects.toMatchObject({
      code: 'ipc.input-validation',
      scope: 'validation',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('出参校验失败时归一化为契约错误', async () => {
    invokeMock.mockResolvedValue({ ok: 'bad' });

    const call = defineIpc({
      name: 'demo_output_validation',
      guardHint: '演示出参校验',
      inSchema: z.void(),
      outSchema: z.object({ ok: z.boolean() }),
    });

    await expect(call(undefined)).rejects.toMatchObject({
      code: 'ipc.contract-violation',
      scope: 'validation',
    });
  });

  it('超时时归一化为 ipc.timeout', async () => {
    invokeMock.mockImplementation(() => new Promise(() => undefined));

    const call = defineIpc({
      name: 'demo_timeout',
      guardHint: '演示超时',
      inSchema: z.void(),
      outSchema: z.void(),
      timeoutMs: 10,
    });

    await expect(call(undefined)).rejects.toMatchObject({
      code: 'ipc.timeout',
      scope: 'ipc',
    });
  });

  it('取消时归一化为 ipc.canceled', async () => {
    const controller = new AbortController();
    controller.abort();

    const call = defineIpc({
      name: 'demo_cancel',
      guardHint: '演示取消',
      inSchema: z.void(),
      outSchema: z.void(),
    });

    await expect(call(undefined, { signal: controller.signal })).rejects.toMatchObject({
      code: 'ipc.canceled',
      scope: 'ipc',
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Rust 抛错时按 errorMap 归一化', async () => {
    invokeMock.mockRejectedValue(new Error('file not found: sample.sh'));

    const call = defineIpc({
      name: 'demo_error_map',
      guardHint: '演示错误映射',
      inSchema: z.void(),
      outSchema: z.void(),
      errorMap: {
        'not found': {
          code: 'fs.not-found',
          message: '目标文件不存在。',
        },
      },
    });

    await expect(call(undefined)).rejects.toMatchObject({
      code: 'fs.not-found',
      scope: 'ipc',
      message: '目标文件不存在。',
    });
  });

  it('无返回值命令兼容 Tauri 的 null 响应', async () => {
    invokeMock.mockResolvedValue(null);

    const call = defineIpc({
      name: 'demo_void_null',
      guardHint: '演示无返回值响应',
      inSchema: z.object({ sessionId: z.string(), data: z.string() }),
      outSchema: zTauriVoid,
    });

    await expect(call({ sessionId: 'term-1', data: 'ls\n' })).resolves.toBeUndefined();
  });

  it('无返回值命令兼容 undefined 响应', async () => {
    invokeMock.mockResolvedValue(undefined);

    const call = defineIpc({
      name: 'demo_void_undefined',
      guardHint: '演示无返回值响应',
      inSchema: z.object({ sessionId: z.string(), data: z.string() }),
      outSchema: zTauriVoid,
    });

    await expect(call({ sessionId: 'term-1', data: 'pwd\n' })).resolves.toBeUndefined();
  });
});

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

  it('loadScript 通过 defineIpc 驱动扁平参数命令', async () => {
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

  it('SSH 配置主机列表支持取消，已取消时不触发 invoke', async () => {
    const controller = new AbortController();
    controller.abort();
    const listHosts = tauriService.listSshConfigHosts as unknown as (
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;

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

  it('agentSidecarResolveApproval 复用 sidecar 长任务超时预算', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation(() => new Promise(() => undefined));

    try {
      const sidecarTaskTimeoutMs = 30 * 60 * 1000;
      const promise = tauriService.agentSidecarResolveApproval({
        requestId: 'approval-request-1',
        decision: 'allow-once',
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

      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(sidecarTaskTimeoutMs - 30_002);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).rejects.toMatchObject({
        code: 'ipc.timeout',
        scope: 'ipc',
      });
    } finally {
      vi.useRealTimers();
    }
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
      expect(invokeMock).toHaveBeenCalledWith('agent_sidecar_restore_checkpoint', {
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
    expect(invokeMock).toHaveBeenCalledWith('agent_sidecar_restart');
  });
});