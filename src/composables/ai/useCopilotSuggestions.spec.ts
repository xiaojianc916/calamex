import { describe, expect, it } from 'vitest';
import { pickFromPool } from '@/composables/ai/useCopilotSuggestions';

const makePool = (size: number): string[] =>
  Array.from({ length: size }, (_, index) => `候选项 ${index + 1}`);

const messagesOf = (pool: readonly string[]): string[] =>
  pickFromPool(pool).map((item) => item.message);

describe('pickFromPool', () => {
  it('最多返回 DISPLAY_COUNT 条且互不相同', () => {
    const pool = makePool(50);
    const messages = messagesOf(pool);

    expect(messages).toHaveLength(9);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(pool).toContain(message);
    }
  });

  it('去重并丢弃空白项', () => {
    const messages = messagesOf(['一', '二', '一', '   ', '三']);

    expect([...messages].sort()).toEqual(['一', '三', '二']);
  });

  it('空池返回空数组', () => {
    expect(pickFromPool([])).toEqual([]);
  });

  it('池小于展示数时返回全部去重项', () => {
    const messages = messagesOf(['甲', '乙']);

    expect([...messages].sort()).toEqual(['乙', '甲']);
  });

  it('多次抽取始终是去重子集', () => {
    const pool = makePool(30);
    for (let run = 0; run < 20; run += 1) {
      const messages = messagesOf(pool);
      expect(messages).toHaveLength(9);
      expect(new Set(messages).size).toBe(messages.length);
      for (const message of messages) {
        expect(pool).toContain(message);
      }
    }
  });
});
