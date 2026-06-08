import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type Ref } from 'vue';

import { useElapsedSeconds } from './useElapsedSeconds';

describe('useElapsedSeconds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T00:00:10.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startedAt 为 null 时返回 0', () => {
    const scope = effectScope();
    let elapsed: Ref<number> | null = null;
    scope.run(() => {
      elapsed = useElapsedSeconds(
        () => null,
        () => true,
      );
    });
    expect(elapsed?.value).toBe(0);
    scope.stop();
  });

  it('活动态每秒递增已用秒数', () => {
    const scope = effectScope();
    let elapsed: Ref<number> | null = null;
    scope.run(() => {
      elapsed = useElapsedSeconds(
        () => '2026-06-08T00:00:00.000Z',
        () => true,
      );
    });
    expect(elapsed?.value).toBe(10);
    vi.advanceTimersByTime(3000);
    expect(elapsed?.value).toBe(13);
    scope.stop();
  });

  it('非活动态冻结,不随时间增长', async () => {
    const active = ref(true);
    const scope = effectScope();
    let elapsed: Ref<number> | null = null;
    scope.run(() => {
      elapsed = useElapsedSeconds(
        () => '2026-06-08T00:00:00.000Z',
        () => active.value,
      );
    });
    vi.advanceTimersByTime(2000);
    expect(elapsed?.value).toBe(12);
    active.value = false;
    await nextTick();
    vi.advanceTimersByTime(5000);
    expect(elapsed?.value).toBe(12);
    scope.stop();
  });

  it('scope 停止后停止滴答', () => {
    const scope = effectScope();
    let elapsed: Ref<number> | null = null;
    scope.run(() => {
      elapsed = useElapsedSeconds(
        () => '2026-06-08T00:00:00.000Z',
        () => true,
      );
    });
    expect(elapsed?.value).toBe(10);
    scope.stop();
    vi.advanceTimersByTime(5000);
    expect(elapsed?.value).toBe(10);
  });
});
