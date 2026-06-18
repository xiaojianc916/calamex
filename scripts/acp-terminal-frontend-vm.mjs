#!/usr/bin/env node
// D7-⑥ 前端 VM：ACP 终端输出 ACL + 终端注册表 composable（ADR-20260617）。
// 注：ACP terminal/* 由 client 自有执行，非 session/update 变体，故本轮无 ui_event.rs 投影；
// 宿主终端子系统（producer）留待后续。本 codemod：4 新文件 + projection/index.ts 重导出。
// 幂等：createFile 按 existsSync 跳过；patchFile 按 marker 跳过、LF 归一、原 EOL 还原。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const createFile = (file, content) => {
  if (existsSync(file)) {
    console.log(`[skip] ${file} 已存在`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  console.log(`[done] created ${file}`);
};

const patchFile = (file, marker, anchor, replacement, keyword) => {
  const original = readFileSync(file, 'utf8');
  if (original.includes(marker)) {
    console.log(`[skip] ${file} 已含 ${marker}`);
    return;
  }
  const hadCrlf = original.includes('\r\n');
  const text = original.replace(/\r\n/g, '\n');
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    console.error(`--- ${file} 上下文 "${keyword}" ---`);
    text.split('\n').forEach((line, idx) => {
      if (line.includes(keyword)) {
        console.error(`${idx + 1}: ${line}`);
      }
    });
    console.error('--- end ---');
    throw new Error(`[${file}] anchor "${keyword}": expected 1 match but found ${count}`);
  }
  const patched = text.replace(anchor, () => replacement);
  writeFileSync(file, hadCrlf ? patched.replace(/\n/g, '\r\n') : patched, 'utf8');
  console.log(`[done] patched ${file}`);
};

const PROJECTION = 'src/components/business/ai/thread/projection';
const COMPOSABLES = 'src/composables/ai';

const fromAcpTerminal = `import type { IAiThreadTerminalSnapshot } from '@/components/business/ai/thread/projection/tool-view';

/**
 * ACP 终端输出 ACL（ADR-20260617 · D7-⑥）。
 *
 * 把 ACP terminal/output 的原始负载（client 侧自有终端的输出快照，形状 unknown）归一到
 * 渲染层终端快照 VM（tool-view.ts 的 IAiThreadTerminalSnapshot），供 toAiThreadToolView
 * 的 resolveTerminal 依赖按 terminalId 查得。ACP 形状（camelCase，见
 * agentclientprotocol.com/protocol/terminals）：
 *   { output: string, truncated?: boolean, exitStatus?: { exitCode, signal } | null }
 *
 * 语义：exitStatus 缺省 / 为 null => 进程仍在运行（streaming=true）；出现 exitStatus
 * 对象 => 已结束（streaming=false）。output 非字符串 / 非对象一律返回 null（无终端输出），
 * 不抛错、不伪造。title 可选透传。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

export const parseAcpTerminalSnapshot = (raw: unknown): IAiThreadTerminalSnapshot | null => {
  if (!isRecord(raw) || typeof raw.output !== 'string') {
    return null;
  }
  const output = raw.output;
  const streaming = raw.exitStatus === null || raw.exitStatus === undefined;
  const title = readString(raw.title);
  return title === null ? { output, streaming } : { title, output, streaming };
};
`;

const fromAcpTerminalSpec = `import { describe, expect, it } from 'vitest';

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
    expect(
      parseAcpTerminalSnapshot({ title: 'pnpm build', output: '', exitStatus: null }),
    ).toEqual({ title: 'pnpm build', output: '', streaming: true });
  });

  it('非对象 / output 非字符串 → null', () => {
    expect(parseAcpTerminalSnapshot(null)).toBeNull();
    expect(parseAcpTerminalSnapshot([])).toBeNull();
    expect(parseAcpTerminalSnapshot({ output: 123 })).toBeNull();
    expect(parseAcpTerminalSnapshot({})).toBeNull();
  });
});
`;

const useAcpTerminals = `import { type ComputedRef, computed, ref } from 'vue';

import { parseAcpTerminalSnapshot } from '@/components/business/ai/thread/projection/from-acp-terminal';
import type { IAiThreadTerminalSnapshot } from '@/components/business/ai/thread/projection/tool-view';
import type { TJsonValue } from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 终端注册表的前端闭环（ADR-20260617 · D7-⑥）。
 *
 * 职责：按 terminalId 维护 client 侧终端的最新快照（IAiThreadTerminalSnapshot），
 * 供 tool-view 的 toAiThreadToolView 经 resolveTerminal 依赖渲染终端内容块。
 *
 * 设计取舍（与 useAcpAvailableCommands / useAcpSessionModes 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 .vue 解耦；
 * - 不在此自订阅 sidecar 流 / 不直接调 IPC：宿主（useAiAssistant）持有唯一事件源，
 *   在收到终端输出更新时调 applyTerminalSnapshot；terminal/release 时 removeTerminal；
 * - 不可变替换：每次更新换新 Map 触发响应；解析失败时 no-op（保留既有快照）。
 *
 * 注：ACP 终端由 client（宿主）自有并执行，输出非经 session/update 下发，故无对应
 * ui_event.rs 投影；宿主终端子系统（producer）留待后续 slice 接入。
 * ========================================================================== */

export interface IUseAcpTerminalsReturn {
  /** 全部终端快照（只读，按 terminalId 索引）。 */
  terminals: ComputedRef<ReadonlyMap<string, IAiThreadTerminalSnapshot>>;
  hasTerminals: ComputedRef<boolean>;
  /** 直接用作 toAiThreadToolView 的 resolveTerminal 依赖。 */
  resolveTerminal: (terminalId: string) => IAiThreadTerminalSnapshot | undefined;
  /** 消费终端输出更新：归一并按 id upsert；空 id / 解析失败则 no-op。 */
  applyTerminalSnapshot: (terminalId: string, rawOutput: TJsonValue) => void;
  /** 移除单个终端（如 terminal/release）。 */
  removeTerminal: (terminalId: string) => void;
  /** 清空全部（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpTerminals = (): IUseAcpTerminalsReturn => {
  const registry = ref<ReadonlyMap<string, IAiThreadTerminalSnapshot>>(
    new Map<string, IAiThreadTerminalSnapshot>(),
  );

  const resolveTerminal = (terminalId: string): IAiThreadTerminalSnapshot | undefined =>
    registry.value.get(terminalId);

  const applyTerminalSnapshot = (terminalId: string, rawOutput: TJsonValue): void => {
    if (terminalId.length === 0) {
      return;
    }
    const snapshot = parseAcpTerminalSnapshot(rawOutput);
    if (snapshot === null) {
      return;
    }
    const next = new Map(registry.value);
    next.set(terminalId, snapshot);
    registry.value = next;
  };

  const removeTerminal = (terminalId: string): void => {
    if (!registry.value.has(terminalId)) {
      return;
    }
    const next = new Map(registry.value);
    next.delete(terminalId);
    registry.value = next;
  };

  const reset = (): void => {
    if (registry.value.size === 0) {
      return;
    }
    registry.value = new Map<string, IAiThreadTerminalSnapshot>();
  };

  return {
    terminals: computed(() => registry.value),
    hasTerminals: computed(() => registry.value.size > 0),
    resolveTerminal,
    applyTerminalSnapshot,
    removeTerminal,
    reset,
  };
};
`;

const useAcpTerminalsSpec = `import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';

import { type IUseAcpTerminalsReturn, useAcpTerminals } from './useAcpTerminals';

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpTerminalsReturn;
  scope.run(() => {
    api = useAcpTerminals();
  });
  // biome-ignore lint/style/noNonNullAssertion: scope.run 同步赋值 api。
  return { api: api!, scope };
};

describe('useAcpTerminals', () => {
  it('初始为空', () => {
    const { api, scope } = mount();
    expect(api.hasTerminals.value).toBe(false);
    expect(api.resolveTerminal('t1')).toBeUndefined();
    scope.stop();
  });

  it('applyTerminalSnapshot 归一并按 id 注册', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: '运行中', exitStatus: null });
    expect(api.hasTerminals.value).toBe(true);
    expect(api.resolveTerminal('t1')).toEqual({ output: '运行中', streaming: true });
    scope.stop();
  });

  it('同 id 更新覆盖（流式增量）', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a', exitStatus: null });
    api.applyTerminalSnapshot('t1', { output: 'ab', exitStatus: { exitCode: 0, signal: null } });
    expect(api.resolveTerminal('t1')).toEqual({ output: 'ab', streaming: false });
    scope.stop();
  });

  it('无效负载 no-op：保留既有快照', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a', exitStatus: null });
    api.applyTerminalSnapshot('t1', { output: 123 });
    expect(api.resolveTerminal('t1')).toEqual({ output: 'a', streaming: true });
    scope.stop();
  });

  it('空 terminalId no-op', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('', { output: 'a' });
    expect(api.hasTerminals.value).toBe(false);
    scope.stop();
  });

  it('removeTerminal 移除', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a' });
    api.removeTerminal('t1');
    expect(api.resolveTerminal('t1')).toBeUndefined();
    scope.stop();
  });

  it('reset 清空', () => {
    const { api, scope } = mount();
    api.applyTerminalSnapshot('t1', { output: 'a' });
    api.reset();
    expect(api.hasTerminals.value).toBe(false);
    scope.stop();
  });
});
`;

createFile(`${PROJECTION}/from-acp-terminal.ts`, fromAcpTerminal);
createFile(`${PROJECTION}/from-acp-terminal.spec.ts`, fromAcpTerminalSpec);
createFile(`${COMPOSABLES}/useAcpTerminals.ts`, useAcpTerminals);
createFile(`${COMPOSABLES}/useAcpTerminals.spec.ts`, useAcpTerminalsSpec);

patchFile(
  `${PROJECTION}/index.ts`,
  'from-acp-terminal',
  "export * from './from-acp-tool-call';",
  "export * from './from-acp-terminal';\nexport * from './from-acp-tool-call';",
  'from-acp-tool-call',
);

console.log('[all done] D7-⑥ 终端 VM（ACL + 注册表 composable）已生成。');
