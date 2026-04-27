import { createStreamingFenceParser } from '@/composables/useStreamingFenceParser';
import { describe, expect, it } from 'vitest';

describe('createStreamingFenceParser', () => {
  it('keeps an open fence as live plaintext without closing it', () => {
    const parser = createStreamingFenceParser('m1');
    const snapshot = parser.append('before\n```ts\nconst value = 1;');

    expect(snapshot.blocks).toHaveLength(0);
    expect(snapshot.openBlock?.id).toBe('m1:0');
    expect(snapshot.openBlock?.closed).toBe(false);
    expect(snapshot.openBlock?.streamState).toBe('open');
    expect(snapshot.openBlock?.content).toBe('const value = 1;');
    expect(snapshot.openBlock?.fence.lang).toBe('ts');
  });

  it('emits a closed block id only when the fence is closed', () => {
    const parser = createStreamingFenceParser('m1');

    expect(parser.append('```sh\necho ok\n').closedBlockIds).toEqual([]);
    const closed = parser.append('```\nafter');

    expect(closed.openBlock).toBeNull();
    expect(closed.blocks).toHaveLength(1);
    expect(closed.blocks[0]?.id).toBe('m1:0');
    expect(closed.blocks[0]?.closed).toBe(true);
    expect(closed.blocks[0]?.streamState).toBe('closed');
    expect(closed.closedBlockIds).toEqual(['m1:0']);

    const next = parser.append('\nmore text');
    expect(next.closedBlockIds).toEqual([]);
  });

  it('keeps block id stable while content arrives in multiple chunks', () => {
    const parser = createStreamingFenceParser('m1');

    const first = parser.append('```python\nprint(');
    const id = first.openBlock?.id;
    const second = parser.append('"hello")\n');

    expect(id).toBe('m1:0');
    expect(second.openBlock?.id).toBe(id);
    expect(second.openBlock?.content).toBe('print("hello")\n');
  });

  it('parses multiple fences with messageId:index ids', () => {
    const parser = createStreamingFenceParser('m2');
    const snapshot = parser.append('```sh\necho a\n```\ntext\n```json\n{"ok":true}\n```');

    expect(snapshot.blocks.map((block) => block.id)).toEqual(['m2:0', 'm2:1']);
    expect(snapshot.blocks.map((block) => block.fence.lang)).toEqual(['sh', 'json']);
    expect(snapshot.closedBlockIds).toEqual(['m2:0', 'm2:1']);
  });

  it('cancels the open fence, preserves text, and ignores later chunks', () => {
    const parser = createStreamingFenceParser('m3');
    parser.append('```ts\nconst pending = true;\n');
    const cancelled = parser.cancel();

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.blocks).toHaveLength(0);
    expect(cancelled.openBlock?.id).toBe('m3:0');
    expect(cancelled.openBlock?.closed).toBe(false);
    expect(cancelled.openBlock?.streamState).toBe('cancelled');
    expect(cancelled.openBlock?.content).toBe('const pending = true;\n');

    const afterCancel = parser.append('```\n');
    expect(afterCancel.openBlock?.streamState).toBe('cancelled');
    expect(afterCancel.blocks).toHaveLength(0);
  });

  it('marks parser completed without forcing an open fence to close', () => {
    const parser = createStreamingFenceParser('m4');
    parser.append('```bash\necho unfinished');
    const completed = parser.complete();

    expect(completed.status).toBe('completed');
    expect(completed.openBlock?.id).toBe('m4:0');
    expect(completed.openBlock?.closed).toBe(false);
    expect(completed.openBlock?.streamState).toBe('open');
  });

  it('exposes stable markdown content before an open fence', () => {
    const parser = createStreamingFenceParser('m5');
    const snapshot = parser.append('前文 **markdown**\n\n```ts\nconst pending = true;\n后续仍在代码里');

    expect(snapshot.stableContent).toBe('前文 **markdown**\n\n');
    expect(snapshot.openBlock?.content).toBe('const pending = true;\n后续仍在代码里');
  });

  it('returns full stable content after the fence closes', () => {
    const parser = createStreamingFenceParser('m6');
    const content = '前文\n\n```ts\nconst ok = true;\n```\n\n后文 **markdown**';
    const snapshot = parser.append(content);

    expect(snapshot.openBlock).toBeNull();
    expect(snapshot.stableContent).toBe(content);
  });
});
