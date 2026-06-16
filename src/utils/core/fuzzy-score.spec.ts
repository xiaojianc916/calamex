import { describe, expect, it } from 'vitest';

import { computeFuzzyScore, isFuzzyMatch } from './fuzzy-score';

describe('computeFuzzyScore', () => {
  it('空查询返回中性分 0', () => {
    expect(computeFuzzyScore('git', '')).toBe(0);
    expect(computeFuzzyScore('', '')).toBe(0);
  });

  it('空文本配非空查询返回 null', () => {
    expect(computeFuzzyScore('', 'git')).toBeNull();
  });

  it('非子序列返回 null（含顺序错误与超长查询）', () => {
    expect(computeFuzzyScore('git', 'xyz')).toBeNull();
    expect(computeFuzzyScore('git', 'tg')).toBeNull();
    expect(computeFuzzyScore('git', 'gitt')).toBeNull();
  });

  it('子序列命中返回数值（支持非前缀的模糊匹配）', () => {
    expect(computeFuzzyScore('git', 'gt')).not.toBeNull();
    expect(computeFuzzyScore('git', 'git')).not.toBeNull();
  });

  it('忽略大小写，且与原串大小写得分一致（边界相同）', () => {
    expect(isFuzzyMatch('Git', 'git')).toBe(true);
    expect(computeFuzzyScore('Git', 'git')).toBe(computeFuzzyScore('git', 'git'));
  });

  it('连续命中优于带间隙命中', () => {
    expect(computeFuzzyScore('git', 'git')!).toBeGreaterThan(computeFuzzyScore('gait', 'git')!);
  });

  it('前缀/词边界命中优于分散命中', () => {
    expect(computeFuzzyScore('gitignore', 'git')!).toBeGreaterThan(
      computeFuzzyScore('subdigit', 'git')!,
    );
  });

  it('词边界命中优于词中命中', () => {
    expect(computeFuzzyScore('my-task', 'task')!).toBeGreaterThan(
      computeFuzzyScore('mytask', 'task')!,
    );
  });

  it('驼峰边界可命中并加分', () => {
    expect(isFuzzyMatch('myTaskRunner', 'tr')).toBe(true);
    expect(computeFuzzyScore('myTaskRunner', 'tr')!).toBeGreaterThan(
      computeFuzzyScore('mytaskrunner', 'tr')!,
    );
  });
});

describe('isFuzzyMatch', () => {
  it('与 computeFuzzyScore 的命中判定一致', () => {
    expect(isFuzzyMatch('git', 'gt')).toBe(true);
    expect(isFuzzyMatch('git', 'zzz')).toBe(false);
    expect(isFuzzyMatch('anything', '')).toBe(true);
  });
});
