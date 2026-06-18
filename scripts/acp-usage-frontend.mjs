#!/usr/bin/env node
// D7-⑦ 前端：ACP usage_update 用量 ACL + 注册表 composable + sidecar union 成员（ADR-20260617）。
// 4 新文件 + projection/index.ts 重导出 + sidecar.ts 新增 TAgentUiEventUsageUpdate 类型与 union 成员。
// 用量 VM 直接复用 ai.schema 的 aiLanguageModelUsageSchema safeParse（与 done.usage 同一 SoT）。
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
      console.error(`--- ${file} 上下文 "${keyword}" ---`);
      text.split('\n').forEach((line, idx) => {
        if (line.includes(keyword)) {
          console.error(`${idx + 1}: ${line}`);
        }
      });
      console.error('--- end ---');
      throw new Error(`[${file}] anchor "${keyword}": expected 1 match but found ${count}`);
    }
    text = text.replace(anchor, () => replacement);
  }
  writeFileSync(file, hadCrlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');
  console.log(`[done] patched ${file}`);
};

const PROJECTION = 'src/components/business/ai/thread/projection';
const COMPOSABLES = 'src/composables/ai';
const SIDECAR_TYPES = 'src/types/ai/sidecar.ts';

const fromAcpUsage = `import type { IAiLanguageModelUsage } from '@/types/ai';
import { aiLanguageModelUsageSchema } from '@/types/ai/schema';

/**
 * ACP 回合用量 ACL（ADR-20260617 · D7-⑦）。
 *
 * 把 ACP usage_update 的原始 usage 对象（逐字透传、形状 unknown）归一到共享
 * IAiLanguageModelUsage VM。直接复用 ai.schema 的 aiLanguageModelUsageSchema 做 safeParse
 * （与 done.usage 同一 SoT，杜绝双 SoT 与手搓字段映射）：成功返回 strip 掉未声明字段后的
 * 用量；失败（缺 inputTokens/outputTokens/totalTokens 或类型不符 / 非对象）一律返回 null，
 * 调用方据此忽略本次更新，不抛错、不伪造零值。
 */
export const parseAcpUsage = (raw: unknown): IAiLanguageModelUsage | null => {
  const result = aiLanguageModelUsageSchema.safeParse(raw);
  return result.success ? result.data : null;
};
`;

const fromAcpUsageSpec = `import { describe, expect, it } from 'vitest';

import { parseAcpUsage } from './from-acp-usage';

describe('parseAcpUsage', () => {
  it('解析合法用量（三必填 token 字段）', () => {
    expect(parseAcpUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('strip 未声明字段并保留 raw 透传', () => {
    expect(
      parseAcpUsage({
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        provider: 'kimi',
        raw: { foo: 'bar' },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, raw: { foo: 'bar' } });
  });

  it('缺必填字段返回 null', () => {
    expect(parseAcpUsage({ inputTokens: 10, outputTokens: 5 })).toBeNull();
  });

  it('字段类型不符返回 null', () => {
    expect(parseAcpUsage({ inputTokens: '10', outputTokens: 5, totalTokens: 15 })).toBeNull();
    expect(parseAcpUsage({ inputTokens: -1, outputTokens: 5, totalTokens: 15 })).toBeNull();
  });

  it('非对象返回 null', () => {
    expect(parseAcpUsage(null)).toBeNull();
    expect(parseAcpUsage(42)).toBeNull();
    expect(parseAcpUsage('usage')).toBeNull();
  });
});
`;

const useAcpUsage = `import { type ComputedRef, computed, ref } from 'vue';

import { parseAcpUsage } from '@/components/business/ai/thread/projection/from-acp-usage';
import type { IAiLanguageModelUsage } from '@/types/ai';
import type { TJsonValue } from '@/types/ai/sidecar';

/* ============================================================================
 * ACP 回合用量的前端闭环（ADR-20260617 · D7-⑦）。
 *
 * 职责：消费 ACP usage_update UI 事件的原始 usage 对象（逐字透传，形状 unknown），经
 * ACL from-acp-usage safeParse 为共享 IAiLanguageModelUsage VM；UI（token 用量条等）
 * 只消费该结构，不直接触碰 ACP 原始负载。
 *
 * 设计取舍（与 useAcpAvailableCommands / useAcpSessionModes 一致，不自创）：
 * - 纯状态化、可在 effectScope 内单测，与 .vue 解耦；
 * - 不在此自订阅 sidecar 流：宿主（useAiAssistant）持有唯一 onSidecarStream 并路由全部
 *   UI 事件，故由宿主在收到 usage_update 时调 applyUsageUpdate，避免重复订阅；
 * - 整份替换（ACP 每次上报完整累计用量）；解析失败时 no-op（保留既有用量，避免把已
 *   显示的用量清零回退）。
 * ========================================================================== */

export interface IUseAcpUsageReturn {
  /** 最新回合用量 VM；null 表示尚无有效用量。 */
  usage: ComputedRef<IAiLanguageModelUsage | null>;
  hasUsage: ComputedRef<boolean>;
  /** 消费 usage_update：归一并整份替换；解析失败则 no-op（保留既有）。 */
  applyUsageUpdate: (rawUsage: TJsonValue) => void;
  /** 清空 VM（如切换 thread / 关闭会话）。 */
  reset: () => void;
}

export const useAcpUsage = (): IUseAcpUsageReturn => {
  const usage = ref<IAiLanguageModelUsage | null>(null);

  const applyUsageUpdate = (rawUsage: TJsonValue): void => {
    const parsed = parseAcpUsage(rawUsage);
    if (parsed === null) {
      return;
    }
    usage.value = parsed;
  };

  const reset = (): void => {
    usage.value = null;
  };

  return {
    usage: computed(() => usage.value),
    hasUsage: computed(() => usage.value !== null),
    applyUsageUpdate,
    reset,
  };
};
`;

const useAcpUsageSpec = `import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';

import { type IUseAcpUsageReturn, useAcpUsage } from './useAcpUsage';

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpUsageReturn;
  scope.run(() => {
    api = useAcpUsage();
  });
  // biome-ignore lint/style/noNonNullAssertion: scope.run 同步赋值 api。
  return { api: api!, scope };
};

describe('useAcpUsage', () => {
  it('初始为空', () => {
    const { api, scope } = mount();
    expect(api.hasUsage.value).toBe(false);
    expect(api.usage.value).toBeNull();
    scope.stop();
  });

  it('applyUsageUpdate 归一并存入 VM', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(api.hasUsage.value).toBe(true);
    expect(api.usage.value).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    scope.stop();
  });

  it('整份替换（后一次覆盖前一次）', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    api.applyUsageUpdate({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(api.usage.value).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    scope.stop();
  });

  it('解析失败 no-op：保留既有用量', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    api.applyUsageUpdate({ inputTokens: 'bad', outputTokens: 1, totalTokens: 2 });
    expect(api.usage.value).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    scope.stop();
  });

  it('reset 清空', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    api.reset();
    expect(api.hasUsage.value).toBe(false);
    scope.stop();
  });
});
`;

const usageUnionType = `/* ----------------------------------------------------------------------------
 * ACP 回合用量 UI 事件（ADR-20260617 · D7-⑦）
 *
 * 投影 ACP session/update 的 usage_update（外部 agent 上报本回合 token 用量，见 Rust host
 * src-tauri/src/acp/ui_event.rs）。事件逐字透传 ACP usage 原始对象（TJsonValue，不在 Rust
 * 侧解读/折算），前端 ACL（components/business/ai/thread/projection/from-acp-usage）经
 * aiLanguageModelUsageSchema safeParse 为共享 IAiLanguageModelUsage VM（与 done.usage 同一
 * SoT schema，避免双 SoT）；UI 只消费该结构，不直接触碰 ACP 原始负载。
 * -------------------------------------------------------------------------- */
export type TAgentUiEventUsageUpdate = {
  type: 'usage_update';
  /** ACP usage_update 的原始 usage 对象，逐字透传，前端 ACL 归一。 */
  usage: TJsonValue;
};`;

createFile(`${PROJECTION}/from-acp-usage.ts`, fromAcpUsage);
createFile(`${PROJECTION}/from-acp-usage.spec.ts`, fromAcpUsageSpec);
createFile(`${COMPOSABLES}/useAcpUsage.ts`, useAcpUsage);
createFile(`${COMPOSABLES}/useAcpUsage.spec.ts`, useAcpUsageSpec);

patchFile(`${PROJECTION}/index.ts`, 'from-acp-usage', [
  [
    "export * from './from-runtime-tool-call';",
    "export * from './from-acp-usage';\nexport * from './from-runtime-tool-call';",
    'from-runtime-tool-call',
  ],
]);

patchFile(SIDECAR_TYPES, 'TAgentUiEventUsageUpdate', [
  ['export type TAgentUiEvent =', `${usageUnionType}\n\nexport type TAgentUiEvent =`, 'TAgentUiEvent ='],
  [
    '  | TAgentUiEventAvailableCommandsUpdate\n',
    '  | TAgentUiEventAvailableCommandsUpdate\n  | TAgentUiEventUsageUpdate\n',
    'TAgentUiEventAvailableCommandsUpdate',
  ],
]);

console.log('[all done] D7-⑦ 前端用量 VM 已生成。');
