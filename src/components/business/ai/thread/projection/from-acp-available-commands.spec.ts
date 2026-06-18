import { describe, expect, it } from 'vitest';

import { parseAcpAvailableCommands } from './from-acp-available-commands';

describe('parseAcpAvailableCommands', () => {
  it('解析合法命令并提取 inputHint', () => {
    const state = parseAcpAvailableCommands([
      { name: 'plan', description: '生成计划' },
      { name: 'test', description: '运行测试', input: { hint: '可选范围' } },
    ]);
    expect(state?.commands).toEqual([
      { name: 'plan', description: '生成计划' },
      { name: 'test', description: '运行测试', inputHint: '可选范围' },
    ]);
  });

  it('跳过缺 name 或 description 非字符串的非法条目', () => {
    const state = parseAcpAvailableCommands([
      { name: 'ok', description: 'desc' },
      { description: '无名' },
      { name: 'bad-desc', description: 123 },
      'not-an-object',
    ]);
    expect(state?.commands).toEqual([{ name: 'ok', description: 'desc' }]);
  });

  it('非数组返回 null', () => {
    expect(parseAcpAvailableCommands(null)).toBeNull();
    expect(parseAcpAvailableCommands({ commands: [] })).toBeNull();
  });

  it('无有效命令返回 null', () => {
    expect(parseAcpAvailableCommands([])).toBeNull();
    expect(parseAcpAvailableCommands([{ foo: 'bar' }])).toBeNull();
  });

  it('忽略非字符串 hint', () => {
    const state = parseAcpAvailableCommands([
      { name: 'x', description: 'd', input: { hint: 123 } },
    ]);
    expect(state?.commands).toEqual([{ name: 'x', description: 'd' }]);
  });
});
