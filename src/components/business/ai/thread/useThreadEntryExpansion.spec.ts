import { describe, expect, it } from 'vitest';
import { nextTick, ref } from 'vue';
import type { IAiThreadReasoningEntry, IAiThreadToolCallEntry, TAiThreadEntry } from './projection';
import { useThreadEntryExpansion } from './useThreadEntryExpansion';

const toolEntry = (overrides: Partial<IAiThreadToolCallEntry> = {}): IAiThreadToolCallEntry => ({
  kind: 'tool-call',
  id: 't1',
  messageId: 'm1',
  icon: 'file',
  title: '读取文件',
  tags: [],
  status: 'succeeded',
  content: [],
  ...overrides,
});

const reasoningEntry = (
  overrides: Partial<IAiThreadReasoningEntry> = {},
): IAiThreadReasoningEntry => ({
  kind: 'reasoning',
  id: 'r1',
  messageId: 'm1',
  segments: ['思考中'],
  isLong: false,
  streaming: false,
  ...overrides,
});

describe('useThreadEntryExpansion', () => {
  it('工具调用默认折叠且可切换', () => {
    const tool = toolEntry();
    const entries = ref<TAiThreadEntry[]>([tool]);
    const expansion = useThreadEntryExpansion(entries);

    expect(expansion.isExpanded(tool)).toBe(false);
    expansion.toggle(tool);
    expect(expansion.isExpanded(tool)).toBe(true);
  });

  it('推理块在流式时自动展开、流式结束后自动折叠', async () => {
    const streaming = reasoningEntry({ streaming: true });
    const entries = ref<TAiThreadEntry[]>([streaming]);
    const expansion = useThreadEntryExpansion(entries);

    expect(expansion.isExpanded(streaming)).toBe(true);

    const finished = reasoningEntry({ streaming: false });
    entries.value = [finished];
    await nextTick();

    expect(expansion.isExpanded(finished)).toBe(false);
  });

  it('推理块结束后用户手动展开会被保留，不被自动逻辑改写', async () => {
    const streaming = reasoningEntry({ streaming: true });
    const entries = ref<TAiThreadEntry[]>([streaming]);
    const expansion = useThreadEntryExpansion(entries);

    const finished = reasoningEntry({ streaming: false });
    entries.value = [finished];
    await nextTick();
    expect(expansion.isExpanded(finished)).toBe(false);

    expansion.setExpanded(finished, true);
    expect(expansion.isExpanded(finished)).toBe(true);

    entries.value = [reasoningEntry({ streaming: false })];
    await nextTick();
    expect(expansion.isExpanded(finished)).toBe(true);
  });

  it('不可展开的条目始终返回 false', () => {
    const userEntry: TAiThreadEntry = {
      kind: 'user-message',
      id: 'u1',
      messageId: 'm1',
      markdown: 'hi',
      references: [],
    };
    const entries = ref<TAiThreadEntry[]>([userEntry]);
    const expansion = useThreadEntryExpansion(entries);

    expect(expansion.isExpanded(userEntry)).toBe(false);
    expansion.setExpanded(userEntry, true);
    expect(expansion.isExpanded(userEntry)).toBe(false);
  });
});
