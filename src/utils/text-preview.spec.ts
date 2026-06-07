import { describe, expect, it } from 'vitest';
import {
  clipTextPreview,
  formatPrioritizedFieldPreview,
  splitTextGraphemes,
} from '@/utils/text-preview';

describe('text-preview', () => {
  it('优先在句子边界裁剪中文预览', () => {
    expect(
      clipTextPreview('今天热点新闻已获取。第二句继续补充更多背景信息。', {
        maxGraphemes: 16,
      }),
    ).toBe('今天热点新闻已获取。...');
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
    const preview = formatPrioritizedFieldPreview(
      [
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
      ],
      {
        maxFields: 3,
        maxGraphemes: 64,
      },
    );

    expect(preview).toContain('查询：淘宝网 最新商品 2026');
    expect(preview).toContain('站点：taobao.com');
    expect(preview).toContain('路径：');
    expect(preview).not.toContain('摘要：');
  });

  it('多字段预览的总渲染长度不超过字符预算', () => {
    const preview = formatPrioritizedFieldPreview(
      [
        { label: 'A', value: 'x'.repeat(50), priority: 90 },
        { label: 'B', value: 'y'.repeat(50), priority: 60 },
        { label: 'C', value: 'z'.repeat(50), priority: 30 },
      ],
      {
        maxFields: 3,
        maxGraphemes: 48,
      },
    );

    expect([...preview].length).toBeLessThanOrEqual(48);
    expect(preview).toContain('A：');
  });

  it('预算紧张时高优先级字段保留更多字符', () => {
    const preview = formatPrioritizedFieldPreview(
      [
        { label: '高', value: '高优先级字段需要尽量完整地展示出来内容', priority: 100 },
        { label: '低', value: '低优先级字段在空间不足时应当被更多地截断掉', priority: 10 },
      ],
      {
        maxFields: 2,
        maxGraphemes: 40,
      },
    );

    const parts = preview.split(' · ');
    const highPart = parts.find((part) => part.startsWith('高：')) ?? '';
    const lowPart = parts.find((part) => part.startsWith('低：')) ?? '';

    expect(preview).toContain('高：');
    expect(preview).toContain('低：');
    expect([...highPart].length).toBeGreaterThan([...lowPart].length);
  });

  it('字素切分对组合字符与 emoji 保持完整，且重复调用结果稳定', () => {
    const sample = 'a\u0301🙂🇨🇳é结尾';
    const first = splitTextGraphemes(sample);
    const second = splitTextGraphemes(sample);

    // 合成的 é、emoji、区域旗帜都应作为单个字素，不被拆散为多个码点。
    expect(first.join('')).toBe(sample);
    expect(first).toContain('🙂');
    expect(first).not.toContain('\u0301');
    // 命中缓存（第二次）应得到与首次完全一致的切分结果。
    expect(second).toEqual(first);
  });

  it('记忆化缓存不会被外部修改污染（返回防御性拷贝）', () => {
    const sample = '缓存隔离测试内容';
    const firstCall = splitTextGraphemes(sample);
    const originalLength = firstCall.length;

    // 改动导出的数组不应影响内部缓存，后续调用仍返回完整结果。
    firstCall.length = 0;
    firstCall.push('污染');

    const secondCall = splitTextGraphemes(sample);
    expect(secondCall.length).toBe(originalLength);
    expect(secondCall.join('')).toBe(sample);
  });

  it('记忆化不改变裁剪结果（与无缓存语义一致）', () => {
    const value = '今天热点新闻已获取。第二句继续补充更多背景信息。';
    const a = clipTextPreview(value, { maxGraphemes: 16 });
    const b = clipTextPreview(value, { maxGraphemes: 16 });

    expect(a).toBe('今天热点新闻已获取。...');
    expect(b).toBe(a);
  });
});
