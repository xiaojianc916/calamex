import { beforeEach, describe, expect, it, vi } from 'vitest';

// 在模块导入前就准备好可被 mock 工厂引用的 consola 实例（vi.hoisted 会提升）。
const { instance } = vi.hoisted(() => ({
  instance: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('consola/browser', () => ({
  createConsola: () => instance,
}));

import { logger } from '@/utils/logger';

describe('logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('info 透传 event 与额外字段（剩余字段剔除 event）', () => {
    logger.info({ event: 'app.start', region: 'cn' });
    expect(instance.info).toHaveBeenCalledWith('app.start', { region: 'cn' });
  });

  it('err 为字符串时规整为 Error 并独立传参', () => {
    logger.error({ event: 'op.fail', err: 'boom', code: 'E1' });
    const call = instance.error.mock.calls[0];
    expect(call?.[0]).toBe('op.fail');
    expect(call?.[1]).toBeInstanceOf(Error);
    expect((call?.[1] as Error).message).toBe('boom');
    expect(call?.[2]).toEqual({ code: 'E1' });
  });

  it('err 为普通对象时通过 JSON 序列化为 Error message', () => {
    logger.warn({ event: 'op.warn', err: { reason: 'x' } });
    const call = instance.warn.mock.calls[0];
    expect((call?.[1] as Error).message).toBe('{"reason":"x"}');
  });

  it('child 合并固定字段且不污染父 logger', () => {
    const child = logger.child({ traceId: 't-1' });
    child.debug({ event: 'step', n: 1 });
    expect(instance.debug).toHaveBeenCalledWith('step', { traceId: 't-1', n: 1 });

    logger.info({ event: 'parent' });
    expect(instance.info).toHaveBeenCalledWith('parent', {});
  });
});
