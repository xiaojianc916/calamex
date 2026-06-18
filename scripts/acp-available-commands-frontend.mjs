#!/usr/bin/env node
// D7-④ ACP available_commands_update：数据/投影/composable 层（ADR-20260617）。
//
// 一个脚本同时改/建 6 个文件：
//   1) src/types/ai/sidecar.ts                                +VM 类型 +UI 事件 +union 成员
//   2) projection/index.ts                                    +re-export
//   3) projection/from-acp-available-commands.ts        (新) ACL parse
//   4) projection/from-acp-available-commands.spec.ts   (新) parse spec
//   5) composables/ai/useAcpAvailableCommands.ts        (新) host-routed composable
//   6) composables/ai/useAcpAvailableCommands.spec.ts   (新) composable spec
//
// 与 D7-③（会话模式）同范围同设计：ACL 在前端投影边界，Rust 仅原始透传，不写 dead host 接线。
// 幂等；patch 前归一 LF 免疫 CRLF/LF 混用，写回按原 EOL 还原。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const patchFile = (file, marker, edits) => {
  const original = readFileSync(file, 'utf8');
  if (original.includes(marker)) {
    console.log(`[skip] ${file} 已含 ${marker}`);
    return;
  }
  const hadCrlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');
  for (const [anchor, replacement, keyword] of edits) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      console.error(`--- ${file} 上下文 \"${keyword}\" ---`);
      text.split('\n').forEach((line, idx) => {
        if (line.includes(keyword)) {
          console.error(`${idx + 1}: ${line}`);
        }
      });
      console.error('--- end ---');
      throw new Error(`[${file}] anchor \"${keyword}\": expected 1 match but found ${count}`);
    }
    text = text.replace(anchor, () => replacement);
  }
  writeFileSync(file, hadCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`[done] patched ${file}`);
};

const createFile = (file, content) => {
  if (existsSync(file)) {
    console.log(`[skip] ${file} 已存在`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  console.log(`[done] created ${file}`);
};

patchFile('src/types/ai/sidecar.ts', 'IAcpAvailableCommandsState', [
  [
    `export interface IAcpSessionModeState {
  currentModeId: string | null;
  availableModes: IAcpSessionModeOption[];
}`,
    `export interface IAcpSessionModeState {
  currentModeId: string | null;
  availableModes: IAcpSessionModeOption[];
}

/* ----------------------------------------------------------------------------
 * ACP 可用斜杠命令 VM（ADR-20260617 · D7-④）
 *
 * 投影 ACP session/update 的 available_commands_update（外部 agent 声明本会话可用的
 * 斜杠命令，见 Rust host src-tauri/src/acp/ui_event.rs）。事件逐字透传 ACP
 * availableCommands 原始数组（TJsonValue[]，不在 Rust 侧造结构），前端 ACL
 * （components/business/ai/thread/projection/from-acp-available-commands）归一为此
 * VM；UI 只消费该结构，不直接触碰 ACP 原始负载。
 * -------------------------------------------------------------------------- */
export interface IAcpAvailableCommand {
  name: string;
  description: string;
  /** ACP AvailableCommandInput.hint（非结构化输入提示），无则省略。 */
  inputHint?: string;
}

export interface IAcpAvailableCommandsState {
  commands: IAcpAvailableCommand[];
}

export type TAgentUiEventAvailableCommandsUpdate = {
  type: 'available_commands_update';
  /** ACP available_commands_update 的原始 availableCommands 数组，逐字透传，前端 ACL 归一。 */
  availableCommands: TJsonValue[];
};`,
    'IAcpSessionModeState',
  ],
  [
    `  | TAgentUiEventModeUpdate
`,
    `  | TAgentUiEventModeUpdate
  | TAgentUiEventAvailableCommandsUpdate
`,
    'TAgentUiEventModeUpdate',
  ],
]);

patchFile(
  'src/components/business/ai/thread/projection/index.ts',
  'from-acp-available-commands',
  [
    [
      `export * from './from-acp-events';
`,
      `export * from './from-acp-available-commands';
export * from './from-acp-events';
`,
      'from-acp-events',
    ],
  ],
);

createFile(
  'src/components/business/ai/thread/projection/from-acp-available-commands.ts',
  `import type { IAcpAvailableCommand, IAcpAvailableCommandsState } from '@/types/ai/sidecar';

/**
 * ACP 可用斜杠命令 ACL（ADR-20260617 · D7-④）。
 *
 * 把 ACP available_commands_update 的原始 availableCommands 数组（逐字透传、形状
 * unknown）归一到前端斜杠命令面板 VM。ACP 形状（camelCase，见
 * agentclientprotocol.com/protocol/slash-commands）：
 *   { name: string, description: string, input?: { hint: string } }
 *
 * 解析失败 / 非数组 / 无有效命令 一律返回 null（面板据此整体隐藏），不抛错、不伪造
 * 默认项。逐项跳过缺 name（或 description 非字符串）的非法条目。
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const parseCommand = (raw: unknown): IAcpAvailableCommand | null => {
  if (!isRecord(raw)) {
    return null;
  }
  const name = readString(raw.name);
  const description = typeof raw.description === 'string' ? raw.description : null;
  if (!name || description === null) {
    return null;
  }
  const inputHint = isRecord(raw.input) ? readString(raw.input.hint) : null;
  return inputHint ? { name, description, inputHint } : { name, description };
};

export const parseAcpAvailableCommands = (raw: unknown): IAcpAvailableCommandsState | null => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const commands = raw
    .map(parseCommand)
    .filter((command): command is IAcpAvailableCommand => command !== null);
  return commands.length > 0 ? { commands } : null;
};
`,
);

createFile(
  'src/components/business/ai/thread/projection/from-acp-available-commands.spec.ts',
  `import { describe, expect, it } from 'vitest';

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
`,
);

createFile(
  'src/composables/ai/useAcpAvailableCommands.ts',
  `import { computed, ref, type ComputedRef } from 'vue';

import { parseAcpAvailableCommands } from '@/components/business/ai/thread/projection/from-acp-available-commands';
import type {
  IAcpAvailableCommand,
  IAcpAvailableCommandsState,
  TJsonValue,
} from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 可用斜杠命令面板的前端闭环（ADR-20260617 · D7-④）。
 *
 * 职责：消费 ACP available_commands_update UI 事件的原始 availableCommands 数组
 * （逐字透传，形状 unknown），经 ACL from-acp-available-commands 归一为命令面板
 * VM；UI 只消费该结构，不直接触碰 ACP 原始负载。
 *
 * 设计取舍（与 useAcpSessionModes 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 .vue 解耦；
 * - 不在此自订阅 sidecar 流：宿主（useAiAssistant）持有唯一的 onSidecarStream 并路由
 *   全部 UI 事件，故由宿主在收到 available_commands_update 时调用 applyCommandsUpdate，
 *   避免重复订阅；
 * - 命令清单按整份替换（ACP 每次推送完整列表）；解析无有效命令时清空（面板隐藏）。
 *
 * 注：ACP 不提供「拉取可用命令」的方法，命令仅经 update 通知下发，故无 loadXxx。
 * ========================================================================== */

export interface IUseAcpAvailableCommandsReturn {
  /** 面板 VM；null 表示无可用命令，面板整体隐藏。 */
  state: ComputedRef<IAcpAvailableCommandsState | null>;
  /** 可用命令清单（无则空数组）。 */
  commands: ComputedRef<IAcpAvailableCommand[]>;
  hasCommands: ComputedRef<boolean>;
  /** 消费 available_commands_update：整份替换；无有效命令则清空。 */
  applyCommandsUpdate: (availableCommands: readonly TJsonValue[]) => void;
  /** 清空 VM（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpAvailableCommands = (): IUseAcpAvailableCommandsReturn => {
  const state = ref<IAcpAvailableCommandsState | null>(null);

  const applyCommandsUpdate = (availableCommands: readonly TJsonValue[]): void => {
    state.value = parseAcpAvailableCommands(availableCommands);
  };

  const reset = (): void => {
    state.value = null;
  };

  return {
    state: computed(() => state.value),
    commands: computed(() => state.value?.commands ?? []),
    hasCommands: computed(() => (state.value?.commands.length ?? 0) > 0),
    applyCommandsUpdate,
    reset,
  };
};
`,
);

createFile(
  'src/composables/ai/useAcpAvailableCommands.spec.ts',
  `import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';

import {
  useAcpAvailableCommands,
  type IUseAcpAvailableCommandsReturn,
} from './useAcpAvailableCommands';

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpAvailableCommandsReturn;
  scope.run(() => {
    api = useAcpAvailableCommands();
  });
  // biome-ignore lint/style/noNonNullAssertion: scope.run 同步赋值 api。
  return { api: api!, scope };
};

describe('useAcpAvailableCommands', () => {
  it('初始为空', () => {
    const { api, scope } = mount();
    expect(api.state.value).toBeNull();
    expect(api.hasCommands.value).toBe(false);
    expect(api.commands.value).toEqual([]);
    scope.stop();
  });

  it('applyCommandsUpdate 归一并填充 VM', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([
      { name: 'plan', description: '生成计划' },
      { name: 'test', description: '运行测试', input: { hint: '范围' } },
    ]);
    expect(api.hasCommands.value).toBe(true);
    expect(api.commands.value).toEqual([
      { name: 'plan', description: '生成计划' },
      { name: 'test', description: '运行测试', inputHint: '范围' },
    ]);
    scope.stop();
  });

  it('整份替换：后一次更新覆盖前一次', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([{ name: 'a', description: 'd' }]);
    api.applyCommandsUpdate([{ name: 'b', description: 'd2' }]);
    expect(api.commands.value).toEqual([{ name: 'b', description: 'd2' }]);
    scope.stop();
  });

  it('空 / 无效更新清空 VM', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([{ name: 'a', description: 'd' }]);
    api.applyCommandsUpdate([]);
    expect(api.state.value).toBeNull();
    expect(api.hasCommands.value).toBe(false);
    scope.stop();
  });

  it('reset 清空 VM', () => {
    const { api, scope } = mount();
    api.applyCommandsUpdate([{ name: 'a', description: 'd' }]);
    api.reset();
    expect(api.state.value).toBeNull();
    scope.stop();
  });
});
`,
);

console.log('[all done] D7-④ available_commands 数据/投影/composable 层已生成。');
