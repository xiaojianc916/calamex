import { describe, expect, it } from 'vitest';

import { selectRenderThread } from '@/store/aiThread/render-authority';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

const entry = {} as unknown as IAiThreadEntry;

function makeThread(id: string, entries: IAiThreadEntry[]): IAiThread {
  return { id, entries } as unknown as IAiThread;
}

describe('selectRenderThread', () => {
  it('始终以 authoritative 为渲染真源（含空 entries）', () => {
    const authoritative = makeThread('a', []);
    expect(selectRenderThread(authoritative)).toBe(authoritative);
  });

  it('authoritative 持有 entries 时返回该线程', () => {
    const authoritative = makeThread('a', [entry]);
    expect(selectRenderThread(authoritative)).toBe(authoritative);
  });

  it('authoritative 为 null 时返回 null', () => {
    expect(selectRenderThread(null)).toBeNull();
  });
});
