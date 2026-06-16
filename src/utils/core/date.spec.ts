import { describe, expect, it } from 'vitest';
import { formatTime } from '@/utils/core/date';

// 用本地时间分量构造 Date，并以"剥离非数字字符"方式断言，
// 既不依赖运行环境时区，也不依赖 zh-CN 分隔符的具体实现细节。
describe('formatTime', () => {
  it('将 Date 格式化为 24 小时制 时:分:秒', () => {
    const date = new Date(2024, 0, 1, 9, 5, 3);
    expect(formatTime(date).replace(/\D/g, '')).toBe('090503');
  });

  it('使用 h23 时制，凌晨显示为 00', () => {
    const date = new Date(2024, 0, 1, 0, 0, 0);
    expect(formatTime(date).replace(/\D/g, '')).toBe('000000');
  });

  it('数值时间戳与等价 Date 结果一致', () => {
    const date = new Date(2024, 5, 15, 13, 30, 45);
    expect(formatTime(date.getTime())).toBe(formatTime(date));
  });

  it('非法日期字符串原样返回', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date');
  });

  it('非法数值返回空字符串', () => {
    expect(formatTime(Number.NaN)).toBe('');
  });

  it('非法 Date 对象返回空字符串', () => {
    expect(formatTime(new Date('invalid'))).toBe('');
  });
});
