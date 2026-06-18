import { describe, expect, it } from 'vitest';

import { parseAcpTerminalSnapshot } from './from-acp-terminal';

describe('parseAcpTerminalSnapshot', () => {
  it('运行中（无 exitStatus）→ streaming=true', () => {
    expect(parseAcpTerminalSnapshot({ output: '编译中...' })).toEqual({
      output: '编译中...',
      streaming: true,
    });
  });

  it('exitStatus 为 null → 仍 streaming', () => {
    expect(parseAcpTerminalSnapshot({ output: 'x', exitStatus: null })).toEqual({
      output: 'x',
      streaming: true,
    });
  });

  it('已退出（exitStatus 为对象）→ streaming=false', () => {
    expect(
      parseAcpTerminalSnapshot({ output: 'done', exitStatus: { exitCode: 0, signal: null } }),
    ).toEqual({ output: 'done', streaming: false });
  });

  it('透传 title', () => {
    expect(parseAcpTerminalSnapshot({ title: 'pnpm build', output: '', exitStatus: null })).toEqual(
      { title: 'pnpm build', output: '', streaming: true },
    );
  });

  it('非对象 / output 非字符串 → null', () => {
    expect(parseAcpTerminalSnapshot(null)).toBeNull();
    expect(parseAcpTerminalSnapshot([])).toBeNull();
    expect(parseAcpTerminalSnapshot({ output: 123 })).toBeNull();
    expect(parseAcpTerminalSnapshot({})).toBeNull();
  });
});
