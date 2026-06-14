import { describe, expect, it } from 'vitest';
import type {
  IAiThreadAssistantTextEntry,
  IAiThreadReasoningEntry,
  TAiThreadEntry,
} from './entry-types';
import { reconcileThreadEntries } from './reconcile-thread-entries';

const assistantText = (
  id: string,
  markdown: string,
  streaming = false,
): IAiThreadAssistantTextEntry => ({
  kind: 'assistant-text',
  id,
  messageId: 'm1',
  markdown,
  streaming,
});

const reasoning = (id: string, segments: string[]): IAiThreadReasoningEntry => ({
  kind: 'reasoning',
  id,
  messageId: 'm1',
  segments,
  isLong: false,
  streaming: false,
});

describe('reconcileThreadEntries', () => {
  it('上一轮为空时原样返回本轮投影', () => {
    const next: TAiThreadEntry[] = [assistantText('a', 'hi')];

    expect(reconcileThreadEntries([], next)).toBe(next);
  });

  it('内容未变的条目沿用旧对象引用,变化的条目获得新引用', () => {
    const previous: TAiThreadEntry[] = [reasoning('r', ['思考']), assistantText('a', 'hello')];
    const next: TAiThreadEntry[] = [reasoning('r', ['思考']), assistantText('a', 'hello world')];

    const result = reconcileThreadEntries(previous, next);

    expect(result[0]).toBe(previous[0]);
    expect(result[1]).toBe(next[1]);
  });

  it('新增 id 采用本轮对象,旧 id 复用', () => {
    const previous: TAiThreadEntry[] = [assistantText('a', 'hello')];
    const sameAgain = assistantText('a', 'hello');
    const added = reasoning('r', ['新']);

    const result = reconcileThreadEntries(previous, [sameAgain, added]);

    expect(result[0]).toBe(previous[0]);
    expect(result[1]).toBe(added);
  });

  it('消失的 id 不会出现在结果中', () => {
    const previous: TAiThreadEntry[] = [assistantText('a', 'x'), reasoning('r', ['y'])];
    const next: TAiThreadEntry[] = [assistantText('a', 'x')];

    const result = reconcileThreadEntries(previous, next);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(previous[0]);
  });

  it('深度比较数组字段', () => {
    const previous: TAiThreadEntry[] = [reasoning('r', ['a', 'b'])];
    const next: TAiThreadEntry[] = [reasoning('r', ['a', 'b', 'c'])];

    const result = reconcileThreadEntries(previous, next);

    expect(result[0]).toBe(next[0]);
  });
});
