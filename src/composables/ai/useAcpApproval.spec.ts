import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';

import type { IAcpPermissionRequestPayload } from '@/types/ai/acp-permission.schema';

import { type IUseAcpApprovalReturn, useAcpApproval } from './useAcpApproval';

const { onAcpApproval, resolveAcpApproval } = vi.hoisted(() => ({
  onAcpApproval: vi.fn(),
  resolveAcpApproval: vi.fn(),
}));

vi.mock('@/services/ipc/ai.service', () => ({
  aiService: { onAcpApproval, resolveAcpApproval },
}));

const buildPayload = (
  overrides: Partial<IAcpPermissionRequestPayload> = {},
): IAcpPermissionRequestPayload => ({
  sessionId: 'session-1',
  toolCallId: 'tool-1',
  options: [
    { optionId: 'allow', name: '允许一次', kind: 'allow_once' },
    { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
  ],
  ...overrides,
});

let capturedHandler: ((payload: IAcpPermissionRequestPayload) => void) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

const mount = (options?: Parameters<typeof useAcpApproval>[0]) => {
  const scope = effectScope();
  let api: IUseAcpApprovalReturn;
  scope.run(() => {
    api = useAcpApproval(options);
  });
  return { api: api!, scope };
};

describe('useAcpApproval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandler = undefined;
    unlisten = vi.fn();
    onAcpApproval.mockImplementation((handler: (payload: IAcpPermissionRequestPayload) => void) => {
      capturedHandler = handler;
      return Promise.resolve(unlisten);
    });
    resolveAcpApproval.mockResolvedValue(true);
  });

  it('将到达的权限请求归一为审批 VM并入队', () => {
    const { api, scope } = mount();
    capturedHandler?.(buildPayload());

    expect(api.hasPending.value).toBe(true);
    expect(api.current.value?.toolCallId).toBe('tool-1');
    expect(api.current.value?.approval.title).toBe('是否允许此工具调用？');
    expect(api.current.value?.approval.options.map((option) => option.id)).toEqual([
      'allow',
      'reject',
    ]);
    scope.stop();
  });

  it('resolve 逐字回投 optionId 并出队', async () => {
    const { api, scope } = mount();
    capturedHandler?.(buildPayload());

    await api.resolve('tool-1', 'allow');

    expect(resolveAcpApproval).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      decision: 'allow',
    });
    expect(api.hasPending.value).toBe(false);
    scope.stop();
  });

  it('同一 toolCallId 重发时原位替换而不重复入队', () => {
    const { api, scope } = mount();
    capturedHandler?.(buildPayload());
    capturedHandler?.(
      buildPayload({
        options: [{ optionId: 'allow2', name: '允许', kind: 'allow_once' }],
      }),
    );

    expect(api.pending.value).toHaveLength(1);
    expect(api.current.value?.approval.options.map((option) => option.id)).toEqual(['allow2']);
    scope.stop();
  });

  it('FIFO：解决队首后推进到下一条', async () => {
    const { api, scope } = mount();
    capturedHandler?.(buildPayload({ toolCallId: 'tool-1' }));
    capturedHandler?.(buildPayload({ toolCallId: 'tool-2' }));

    expect(api.current.value?.toolCallId).toBe('tool-1');
    await api.resolve('tool-1', 'allow');
    expect(api.current.value?.toolCallId).toBe('tool-2');
    scope.stop();
  });

  it('resolveContext 注入标题', () => {
    const { api, scope } = mount({ resolveContext: () => ({ title: '允许执行 git push？' }) });
    capturedHandler?.(buildPayload());

    expect(api.current.value?.approval.title).toBe('允许执行 git push？');
    scope.stop();
  });

  it('回投失败时恢复待办并抛出', async () => {
    resolveAcpApproval.mockRejectedValueOnce(new Error('boom'));
    const { api, scope } = mount();
    capturedHandler?.(buildPayload());

    await expect(api.resolve('tool-1', 'allow')).rejects.toThrow('boom');
    expect(api.hasPending.value).toBe(true);
    expect(api.current.value?.toolCallId).toBe('tool-1');
    scope.stop();
  });

  it('作用域销毁时解除订阅', async () => {
    const { scope } = mount();
    await Promise.resolve();
    scope.stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
