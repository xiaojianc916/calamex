import { describe, expect, it } from 'vitest';
import type { IAiConversationThread } from '@/store/aiConversation';
import {
  type IConversationStoreLike,
  type IEntriesMirrorDeps,
  installEntriesMirror,
  mirrorConversationToEntries,
  resolveMirrorOnHydrate,
} from '@/store/aiThread/entriesMirrorBridge';
import { projectConversationToThreadPersist } from '@/store/aiThread/project';

const makeLegacyThread = (id: string): IAiConversationThread =>
  ({
    id,
    title: 'T-' + id,
    titleStatus: 'temporary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages: [],
  }) as unknown as IAiConversationThread;

const makeStore = (
  threads: IAiConversationThread[],
  activeThreadId: string | null,
): IConversationStoreLike & { fire: () => void } => {
  let cb: (() => void) | null = null;
  return {
    activeThreadId,
    threads,
    $subscribe: (callback: () => void) => {
      cb = callback;
      return () => {
        cb = null;
      };
    },
    fire: () => cb?.(),
  };
};

const makeDeps = () => {
  const scheduled: string[] = [];
  let raw: string | null = null;
  const deps: IEntriesMirrorDeps = {
    schedulePersist: (value: string) => {
      scheduled.push(value);
    },
    hydrateSnapshot: async () => ({ raw }),
  };
  return {
    deps,
    scheduled,
    setRaw: (value: string | null) => {
      raw = value;
    },
  };
};

describe('entriesMirrorBridge', () => {
  it('mirrorConversationToEntries 投影当前状态并入双写队列', () => {
    const { deps, scheduled } = makeDeps();
    const store = makeStore([makeLegacyThread('a'), makeLegacyThread('b')], 'b');
    mirrorConversationToEntries(store, deps);
    expect(scheduled).toHaveLength(1);
    const snapshot = JSON.parse(scheduled[0]) as {
      activeThreadId: string;
      threads: { id: string }[];
    };
    expect(snapshot.activeThreadId).toBe('b');
    expect(snapshot.threads.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('installEntriesMirror 立即镜像一次, 订阅触发后再次镜像, stop 后停止', () => {
    const { deps, scheduled } = makeDeps();
    const store = makeStore([makeLegacyThread('a')], 'a');
    const stop = installEntriesMirror(store, deps);
    expect(scheduled).toHaveLength(1);
    store.fire();
    expect(scheduled).toHaveLength(2);
    stop();
    store.fire();
    expect(scheduled).toHaveLength(2);
  });

  it('resolveMirrorOnHydrate: 新 key 有效 → source entries', async () => {
    const { deps, setRaw } = makeDeps();
    const store = makeStore([makeLegacyThread('a'), makeLegacyThread('b')], 'a');
    const projected = projectConversationToThreadPersist({
      activeThreadId: 'a',
      threads: [makeLegacyThread('a'), makeLegacyThread('b')],
    });
    setRaw(JSON.stringify(projected));
    const resolved = await resolveMirrorOnHydrate(store, deps);
    expect(resolved.source).toBe('entries');
    expect(resolved.threads.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('resolveMirrorOnHydrate: 新 key 为空 → 回退 legacy', async () => {
    const { deps, setRaw } = makeDeps();
    setRaw(null);
    const store = makeStore([makeLegacyThread('x')], 'x');
    const resolved = await resolveMirrorOnHydrate(store, deps);
    expect(resolved.source).toBe('legacy');
    expect(resolved.threads.map((t) => t.id)).toEqual(['x']);
  });
});
