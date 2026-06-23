import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { idbMock } = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    idbMock: {
      map,
      createStore: vi.fn(() => ({})),
      get: vi.fn(async (key: string) => map.get(key)),
      set: vi.fn(async (key: string, value: string) => {
        map.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        map.delete(key);
      }),
    },
  };
});

vi.mock('idb-keyval', () => ({
  createStore: idbMock.createStore,
  get: idbMock.get,
  set: idbMock.set,
  del: idbMock.del,
}));

const POINTER_PREFIX = 'idb://ai-conversation-attachment-preview/';
const KEY_PREFIX = 'ai-conversation-attachment-preview:';

const loadModule = async () => {
  vi.resetModules();
  return import('./attachmentPreviewStorage');
};

beforeEach(() => {
  idbMock.map.clear();
  idbMock.createStore.mockClear();
  idbMock.get.mockClear();
  idbMock.set.mockClear();
  idbMock.del.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachmentPreviewStorage', () => {
  it('preparePersistValue 把 data:image base64 抽取为 idb:// 指针并存入 idb', async () => {
    const mod = await loadModule();
    const snapshot = JSON.stringify({
      threads: [{ references: [{ attachmentPreview: { src: 'data:image/png;base64,ABC' } }] }],
    });

    const prepared = await mod.preparePersistValue(snapshot);
    const parsed = JSON.parse(prepared) as {
      threads: Array<{ references: Array<{ attachmentPreview: { src: string } }> }>;
    };

    const pointer = parsed.threads[0].references[0].attachmentPreview.src;
    expect(pointer.startsWith(POINTER_PREFIX)).toBe(true);
    const id = pointer.slice(POINTER_PREFIX.length);
    expect(idbMock.map.get(`${KEY_PREFIX}${id}`)).toBe('data:image/png;base64,ABC');
  });

  it('preparePersistValue 无内联图片时走 fast path 原样返回且不写 idb', async () => {
    const mod = await loadModule();
    const snapshot = JSON.stringify({ threads: [{ text: 'hello' }] });

    const prepared = await mod.preparePersistValue(snapshot);

    expect(prepared).toBe(snapshot);
    expect(idbMock.set).not.toHaveBeenCalled();
  });

  it('preparePersistValue 对同一图片产生幂等 id（不产生重复 blob）', async () => {
    const mod = await loadModule();
    const makeSnapshot = () =>
      JSON.stringify({
        references: [{ attachmentPreview: { src: 'data:image/png;base64,DUP' } }],
      });

    const first = await mod.preparePersistValue(makeSnapshot());
    const second = await mod.preparePersistValue(makeSnapshot());

    expect(first).toBe(second);
    expect(idbMock.map.size).toBe(1);
  });

  it('restoreAttachmentPreviewPointers 按需把指针解析回 base64 且不改动原对象', async () => {
    idbMock.map.set(`${KEY_PREFIX}b1`, 'data:image/png;base64,OTHER');
    const mod = await loadModule();

    const input = [{ references: [{ attachmentPreview: { src: `${POINTER_PREFIX}b1` } }] }];
    const result = await mod.restoreAttachmentPreviewPointers(input);

    expect(result.changed).toBe(true);
    expect(result.value[0].references[0].attachmentPreview.src).toBe('data:image/png;base64,OTHER');
    // 深拷贝：原对象保持指针不变
    expect(input[0].references[0].attachmentPreview.src).toBe(`${POINTER_PREFIX}b1`);
  });

  it('restoreAttachmentPreviewPointers 无指针时 changed=false 并原样返回', async () => {
    const mod = await loadModule();

    const input = [{ references: [{ attachmentPreview: { src: 'data:image/png;base64,X' } }] }];
    const result = await mod.restoreAttachmentPreviewPointers(input);

    expect(result.changed).toBe(false);
    expect(result.value).toBe(input);
  });
});
