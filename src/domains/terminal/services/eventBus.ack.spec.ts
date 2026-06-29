import type { Event, EventCallback, UnlistenFn } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHAR_COUNT_ACK_SIZE,
  createTerminalEventBus,
  type TTerminalListen,
} from '@/domains/terminal/services/eventBus';

/**
 * 最小 listen 替身:把每个事件名的 handler 存起来,供测试手动注入 payload。
 */
const setupBus = () => {
  const handlers = new Map<string, EventCallback<unknown>>();
  const listenMock = vi.fn(
    async (eventName: string, handler: EventCallback<unknown>): Promise<UnlistenFn> => {
      handlers.set(eventName, handler);
      return () => {
        handlers.delete(eventName);
      };
    },
  ) as unknown as TTerminalListen;

  const acknowledge = vi.fn((_sessionId: string, _charCount: number): void => {});
  const eventBus = createTerminalEventBus(listenMock, acknowledge);

  const emit = (eventName: string, payload: unknown): void => {
    const handler = handlers.get(eventName);
    if (!handler) {
      throw new Error(`no handler registered for ${eventName}`);
    }
    handler({ event: eventName, id: 1, payload } as Event<unknown>);
  };

  const emitData = (sessionId: string, length: number): void => {
    emit('terminal:data', { sessionId, data: 'x'.repeat(length) });
  };

  return { handlers, acknowledge, eventBus, emit, emitData };
};

describe('terminal event bus — ack 背压计数', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('不足阈值时不 ack', async () => {
    const { acknowledge, eventBus, emitData } = setupBus();
    await eventBus.start();

    emitData('s1', CHAR_COUNT_ACK_SIZE - 1);

    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('跨过阈值时 ack 一次,并带上累计字符数', async () => {
    const { acknowledge, eventBus, emitData } = setupBus();
    await eventBus.start();

    emitData('s1', CHAR_COUNT_ACK_SIZE);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith('s1', CHAR_COUNT_ACK_SIZE);
  });

  it('多个小块累加后才 ack,并报出累计总数', async () => {
    const { acknowledge, eventBus, emitData } = setupBus();
    await eventBus.start();

    emitData('s1', 3000); // < 阈值,不 ack
    expect(acknowledge).not.toHaveBeenCalled();

    emitData('s1', 2500); // 5500 >= 阈值
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith('s1', 5500);
  });

  it('ack 后累计归零,重新累加', async () => {
    const { acknowledge, eventBus, emitData } = setupBus();
    await eventBus.start();

    emitData('s1', CHAR_COUNT_ACK_SIZE); // ack #1
    emitData('s1', 1000); // 归零后重新累加,仍 < 阈值

    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('按会话独立累计', async () => {
    const { acknowledge, eventBus, emitData } = setupBus();
    await eventBus.start();

    emitData('s1', 3000);
    emitData('s2', 3000); // 两会话各自 < 阈值
    expect(acknowledge).not.toHaveBeenCalled();

    emitData('s1', 3000); // s1 达 6000 >= 阈值
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith('s1', 6000);
  });

  it('无 data 订阅者时仍然 ack(数据已离开后端)', async () => {
    const { acknowledge, eventBus, emitData } = setupBus();
    // 注意:不调 onTerminalData。
    await eventBus.start();

    emitData('s1', CHAR_COUNT_ACK_SIZE);

    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith('s1', CHAR_COUNT_ACK_SIZE);
  });

  it('交互退出后清除会话累计', async () => {
    const { acknowledge, eventBus, emit, emitData } = setupBus();
    await eventBus.start();

    emitData('s1', 4000); // < 阈值,不 ack
    emit('terminal:interactive-exited', { sessionId: 's1', exitCode: 0 });
    emitData('s1', 4000); // 若未清除会达 8000 触发 ack;已清除则重新从 4000 起算

    expect(acknowledge).not.toHaveBeenCalled();
  });
});
