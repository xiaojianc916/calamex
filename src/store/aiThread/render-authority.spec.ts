import { describe, expect, it } from 'vitest';

import { selectRenderThread } from '@/store/aiThread/render-authority';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

const entry = {} as unknown as IAiThreadEntry;

function makeThread(id: string, entries: IAiThreadEntry[]): IAiThread {
  return { id, entries } as unknown as IAiThread;
}

describe('selectRenderThread', () => {
  it('authoritative 持有 entries 时以其为渲染真源', () => {
    const authoritative = makeThread('a', [entry]);
    const fallback = makeThread('legacy', [entry, entry]);
    expect(selectRenderThread(authoritative, fallback)).toBe(authoritative);
  });

  it('authoritative 为空 entries 时回退 legacy', () => {
    const authoritative = makeThread('a', []);
    const fallback = makeThread('legacy', [entry]);
    expect(selectRenderThread(authoritative, fallback)).toBe(fallback);
  });

  it('authoritative 为 null 时回退 legacy', () => {
    const fallback = makeThread('legacy', [entry]);
    expect(selectRenderThread(null, fallback)).toBe(fallback);
  });

  it('authoritative 空 entries 且 fallback 为 null 时返回 null', () => {
    expect(selectRenderThread(makeThread('a', []), null)).toBeNull();
  });

  it('authoritative 与 fallback 皆 null 时返回 null', () => {
    expect(selectRenderThread(null, null)).toBeNull();
  });
});
