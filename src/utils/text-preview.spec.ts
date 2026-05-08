import { clipTextPreview, formatPrioritizedFieldPreview } from '@/utils/text-preview';
import { describe, expect, it } from 'vitest';

describe('text-preview', () => {
  it('优先在句子边界裁剪中文预览', () => {
    expect(clipTextPreview('今天热点新闻已获取。第二句继续补充更多背景信息。', {
      maxGraphemes: 16,
    })).toBe('今天热点新闻已获取。...');
  });

  it('裁剪时保留 emoji 这类组合字符的完整语义', () => {
    const preview = clipTextPreview('搜索🙂结果继续追加', {
      maxGraphemes: 7,
    });

    expect(preview).toContain('🙂');
    expect(preview).toMatch(/\.\.\.$/u);
    expect(preview).not.toContain('�');
  });

  it('按字段优先级分配预算，避免低价值长字段挤掉查询和站点', () => {
    const preview = formatPrioritizedFieldPreview([
      {
        label: '路径',
        value: 'D:/repo/src/components/business/ai/AiAgentRuntimeTimeline.vue',
        priority: 60,
        minGraphemes: 10,
      },
      {
        label: '摘要',
        value: '这里是一段很长的工具结果摘要，会占用大量空间，但在活动行里优先级低于查询和站点。',
        priority: 20,
      },
      {
        label: '查询',
        value: '淘宝网 最新商品 2026',
        priority: 100,
      },
      {
        label: '站点',
        value: 'taobao.com',
        priority: 80,
      },
    ], {
      maxFields: 3,
      maxGraphemes: 64,
    });

    expect(preview).toContain('查询：淘宝网 最新商品 2026');
    expect(preview).toContain('站点：taobao.com');
    expect(preview).toContain('路径：');
    expect(preview).not.toContain('摘要：');
  });
});
