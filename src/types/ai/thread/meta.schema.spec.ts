import { describe, expect, it } from 'vitest';

import {
  aiConversationScrollStateSchema,
  aiConversationTitleStatusSchema,
  aiThreadScrollStateSchema,
  aiThreadTitleStatusSchema,
} from '@/types/ai/thread/meta.schema';

describe('AI thread 共享元信息 schema', () => {
  it('titleStatus 接受四个合法状态，拒绝未知值', () => {
    for (const status of ['temporary', 'generating', 'generated', 'failed'] as const) {
      expect(aiThreadTitleStatusSchema.parse(status)).toBe(status);
    }
    expect(() => aiThreadTitleStatusSchema.parse('unknown')).toThrow();
  });

  it('scrollState 校验非负数值，拒绝负值', () => {
    const scrollState = {
      scrollTop: 0,
      scrollHeight: 120,
      clientHeight: 80,
      distanceFromBottom: 40,
      updatedAt: '2026-06-19T10:00:00.000Z',
    };
    expect(aiThreadScrollStateSchema.parse(scrollState)).toEqual(scrollState);
    expect(() => aiThreadScrollStateSchema.parse({ ...scrollState, scrollTop: -1 })).toThrow();
  });

  it('旧名别名与新名指向同一 schema 实例（向后兼容契约）', () => {
    expect(aiConversationTitleStatusSchema).toBe(aiThreadTitleStatusSchema);
    expect(aiConversationScrollStateSchema).toBe(aiThreadScrollStateSchema);
  });
});
