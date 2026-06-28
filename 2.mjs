#!/usr/bin/env node
/* ============================================================================
 * P6 Commit 4 — 退役 legacy「thread 形状」桥接（idempotent / 原子）
 *
 * 北极星：唯一标准管线、按域、模块化、优雅、不留新旧杂糅与兼容层。
 *
 * 本提交把 aiThread store 上仅剩的 legacy *thread 形状* 桥接整组退役：
 *   1) 编排器 activeConversationScrollState 改读权威 authoritativeActiveThread；
 *   2) store 删除 activeConversationThread / conversationHistoryThreads 两个
 *      legacy 形状 getter，及 replaceMessages / replaceThreadMessages 两个
 *      legacy message setter（写路径已于 C3 全量改走 patchActiveThreadEntries）；
 *   3) legacy-adapter 删除 threadToLegacyThread（仅上面两个 getter 使用）；
 *   4) reverse spec 移除 threadToLegacyThread 的 describe 块与相关 import。
 *
 * 保留：activeMessages + threadEntriesToMessages（仍供续聊上下文/token 只读投影，
 *   待 token 与 chatStream 走 entries-native 后于后续提交一并清退）。
 *
 * 用法（在仓库根目录）：  node 4.mjs
 * 干跑指定目录：          node 4.mjs <baseDir>
 *
 * 幂等：每条替换带 doneToken/goneToken；已应用则跳过，可安全重复执行，
 * 全部校验通过才写盘（validate-all-then-write），任一锚点不匹配则零写入退出。
 * ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.argv[2] || '.';
const ALLOW_MISSING = process.env.ALLOW_MISSING === '1';

const nl = (lines) => lines.join('\n');

function isDone(src, r) {
  if (r.doneToken) return src.includes(r.doneToken);
  if (r.goneToken) return !src.includes(r.goneToken);
  return false;
}

const preview = (s, n = 220) => JSON.stringify(s.length > n ? s.slice(0, n) + '…' : s);

function localLines(src, hint, max = 12) {
  if (!hint) return [];
  return src.split('\n').filter((l) => l.includes(hint)).slice(0, max);
}

function run(base, files) {
  // ---- Phase 1: validate everything, write nothing ----
  const plans = [];
  for (const f of files) {
    const path = join(base, f.file);
    if (!existsSync(path)) {
      if (ALLOW_MISSING) {
        console.warn(`! 跳过缺失文件(ALLOW_MISSING): ${f.file}`);
        continue;
      }
      console.error(`✗ 缺少文件: ${path}`);
      process.exit(1);
    }
    const src = readFileSync(path, 'utf8');
    const apply = [];
    let skipped = 0;
    for (const r of f.replacements) {
      const want = r.count ?? 1;
      const hits = src.split(r.find).length - 1;
      if (hits === want) {
        apply.push(r);
      } else if (hits === 0 && isDone(src, r)) {
        skipped++;
      } else {
        console.error(`\n✗ 锚点不匹配 [${f.file}] :: 命中 ${hits} 次, 期望 ${want}`);
        console.error(`  find = ${preview(r.find)}`);
        const ctx = localLines(src, r.hint);
        if (ctx.length) {
          console.error('  附近相关行:');
          for (const l of ctx) console.error(`   | ${l}`);
        }
        process.exit(1);
      }
    }
    plans.push({ path, file: f.file, src, apply, skipped });
  }

  // ---- Phase 2: apply (all validated) ----
  let totalApplied = 0;
  for (const p of plans) {
    let out = p.src;
    for (const r of p.apply) out = out.split(r.find).join(r.replace);
    if (p.apply.length > 0) writeFileSync(p.path, out);
    totalApplied += p.apply.length;
    console.log(`${p.file}: 改 ${p.apply.length} 处, 跳过 ${p.skipped} 处`);
  }
  console.log(`\n完成：共应用 ${totalApplied} 处替换。`);
}

/* ===========================================================================
 * 替换清单
 * ======================================================================== */
const files = [
  // -------------------------------------------------------------------------
  // 1) 编排器：滚动状态改读权威；刷新陈旧注释
  // -------------------------------------------------------------------------
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    replacements: [
      {
        // O1: 刷新别名注释（移除对将被删除成员的描述）
        find: nl([
          '  // ④.1 §D：编排器消息读写真源收敛到 aiThread 权威 entries（drop-in）。conversationStore',
          '  // 别名保留以最小化触点；活动/历史线程改读 legacy 形状 getter（activeConversationThread /',
          '  // conversationHistoryThreads），其余面（activeMessages / activeThreadId / replace* / 生命周期）1:1 同名。',
          '  const conversationStore = aiThreadStore;',
        ]),
        replace: nl([
          '  // ④.1 §D：编排器消息读写真源收敛到 aiThread 权威 entries。conversationStore 别名保留以',
          '  // 最小化触点；活动滚动状态改读权威 authoritativeActiveThread，其余面（activeMessages /',
          '  // activeThreadId / 生命周期）1:1 同名。',
          '  const conversationStore = aiThreadStore;',
        ]),
        doneToken: '活动滚动状态改读权威 authoritativeActiveThread',
        hint: 'conversationStore = aiThreadStore',
      },
      {
        // O2: scrollState 改读权威 authoritativeActiveThread
        find: '    () => conversationStore.activeConversationThread?.scrollState ?? null,',
        replace: '    () => aiThreadStore.authoritativeActiveThread?.scrollState ?? null,',
        doneToken: '    () => aiThreadStore.authoritativeActiveThread?.scrollState ?? null,',
        hint: 'activeConversationScrollState',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 2) store：删除 legacy 形状 getter / message setter，收敛 import 与 return
  // -------------------------------------------------------------------------
  {
    file: 'src/store/aiThread/index.ts',
    replacements: [
      {
        // S1: import 收敛（只保留 threadEntriesToMessages）
        find: nl([
          'import {',
          '  legacyMessageToEntries,',
          '  threadEntriesToMessages,',
          '  threadToLegacyThread,',
          "} from '@/store/aiThread/legacy-adapter';",
        ]),
        replace: "import { threadEntriesToMessages } from '@/store/aiThread/legacy-adapter';",
        doneToken: "import { threadEntriesToMessages } from '@/store/aiThread/legacy-adapter';",
        hint: 'legacy-adapter',
      },
      {
        // S2: 刷新桥接段头注释
        find: nl([
          '  /* ==================================================================',
          '   * Step 8 ④.2-B：message 形状桥接（useAiConversationStore 编排面的 drop-in）',
          '   * 在 entries 权威之上提供同名 message 形状读写面，供编排器/标题/历史组合式逐一',
          '   * 改指本 store。读经 threadEntriesToMessages / threadToLegacyThread 还原（有损',
          '   * 边界见 legacy-adapter 文件头）；写经 legacyMessageToEntries 折叠为 entries 提交',
          '   * 到权威线程（单写者）。本步纯新增、无上层调用 → 零行为变化。',
          '   * ================================================================ */',
        ]),
        replace: nl([
          '  /* ==================================================================',
          '   * Step 8 ④.2-B → ④.3：entries 写真源面（编排器已接管）',
          '   * 在 entries 权威之上提供 activeThreadId / activeMessages 只读投影与',
          '   * patchActiveThreadEntries 写真源。activeMessages 经 threadEntriesToMessages',
          '   * 还原，仅供续聊上下文与 token 估算（有损边界见 legacy-adapter 文件头）。',
          '   * 编排器写路径已全部走 patchActiveThreadEntries；legacy message 形状 setter 与',
          '   * thread 形状 getter 已退役。',
          '   * ================================================================ */',
        ]),
        doneToken: 'Step 8 ④.2-B → ④.3：entries 写真源面（编排器已接管）',
        hint: 'message 形状桥接',
      },
      {
        // S3: 删除 activeConversationThread / conversationHistoryThreads 两个 getter
        find: nl([
          '  const activeConversationThread = computed(() =>',
          '    authoritativeActiveThread.value ? threadToLegacyThread(authoritativeActiveThread.value) : null,',
          '  );',
          '',
          '  const conversationHistoryThreads = computed(() =>',
          '    authoritativeHistoryThreads.value.map(threadToLegacyThread),',
          '  );',
          '',
          '',
        ]),
        replace: '',
        goneToken: 'const activeConversationThread = computed(() =>',
        hint: 'conversationHistoryThreads',
      },
      {
        // S4: 刷新 patchActiveThreadEntries 文档注释
        find: nl([
          '  /**',
          '   * Entries-native 写真源：以 updater 直接变换活动线程 entries 并提交（经 patchActiveThread 归一）。',
          '   * 供编排器各写点取代 legacy message setter（replaceMessages / replaceThreadMessages）逐一改指。',
          '   */',
        ]),
        replace: nl([
          '  /**',
          '   * Entries-native 写真源：以 updater 直接变换活动线程 entries 并提交（经 patchActiveThread 归一）。',
          '   * 编排器所有写点统一经此提交（已取代退役的 legacy message setter）。',
          '   */',
        ]),
        doneToken: '编排器所有写点统一经此提交（已取代退役的 legacy message setter）。',
        hint: 'Entries-native 写真源',
      },
      {
        // S5: 删除 replaceMessages / replaceThreadMessages 两个 setter
        find: nl([
          '  function replaceMessages(messages: IAiChatMessage[]): void {',
          '    commitAuthoritativeState(',
          '      threadMutations.patchActiveThread(readAuthoritativeState(), (thread) => ({',
          '        ...thread,',
          '        entries: messages.flatMap(legacyMessageToEntries),',
          '      })),',
          '    );',
          '  }',
          '',
          '  function replaceThreadMessages(threadId: string, messages: IAiChatMessage[]): void {',
          '    commitAuthoritativeState(',
          '      threadMutations.patchThread(readAuthoritativeState(), threadId, (thread) => ({',
          '        ...thread,',
          '        entries: messages.flatMap(legacyMessageToEntries),',
          '      })),',
          '    );',
          '  }',
          '',
          '',
        ]),
        replace: '',
        goneToken: 'function replaceMessages(messages: IAiChatMessage[]): void {',
        hint: 'replaceThreadMessages',
      },
      {
        // S6: 收敛 return 面
        find: nl([
          '    // Step 8 ④.2-B：message 形状桥接（drop-in for useAiConversationStore，未接线）',
          '    activeThreadId,',
          '    activeMessages,',
          '    activeConversationThread,',
          '    conversationHistoryThreads,',
          '    patchActiveThreadEntries,',
          '    replaceMessages,',
          '    replaceThreadMessages,',
          '  };',
        ]),
        replace: nl([
          '    // Step 8 ④.3：entries 写真源面（activeMessages 为续聊/token 只读投影）',
          '    activeThreadId,',
          '    activeMessages,',
          '    patchActiveThreadEntries,',
          '  };',
        ]),
        doneToken: nl(['    patchActiveThreadEntries,', '  };']),
        hint: 'patchActiveThreadEntries,',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 3) legacy-adapter：删除 threadToLegacyThread（仅被已删 getter 使用）
  // -------------------------------------------------------------------------
  {
    file: 'src/store/aiThread/legacy-adapter.ts',
    replacements: [
      {
        find:
          '\n\n' +
          nl([
            '/** 把 IAiThread（entries）折叠回 legacy 会话线程（legacyThreadToThread 的逆，沿用元信息）。 */',
            'export function threadToLegacyThread(thread: IAiThread): IAiConversationThread {',
            '  return {',
            '    id: thread.id,',
            '    title: thread.title,',
            '    titleStatus: thread.titleStatus,',
            '    createdAt: thread.createdAt,',
            '    updatedAt: thread.updatedAt,',
            '    messages: threadEntriesToMessages(thread.entries),',
            '    ...(thread.scrollState ? { scrollState: thread.scrollState } : {}),',
            '  };',
            '}',
          ]) +
          '\n',
        replace: '\n',
        goneToken: 'export function threadToLegacyThread(',
        hint: 'threadToLegacyThread',
      },
    ],
  },

  // -------------------------------------------------------------------------
  // 4) reverse spec：移除 threadToLegacyThread 测试块与相关 import
  // -------------------------------------------------------------------------
  {
    file: 'src/store/aiThread/legacy-adapter.reverse.spec.ts',
    replacements: [
      {
        // R1: import 收敛
        find: nl([
          "import { describe, expect, it } from 'vitest';",
          "import type { IAiChatMessage } from '@/types/ai';",
          "import type { IAiConversationThread } from '@/types/ai/conversation.schema';",
          '',
          'import {',
          '  legacyMessageToEntries,',
          '  legacyThreadToThread,',
          '  threadEntriesToMessages,',
          '  threadToLegacyThread,',
          "} from './legacy-adapter';",
        ]),
        replace: nl([
          "import { describe, expect, it } from 'vitest';",
          "import type { IAiChatMessage } from '@/types/ai';",
          '',
          "import { legacyMessageToEntries, threadEntriesToMessages } from './legacy-adapter';",
        ]),
        doneToken: "import { legacyMessageToEntries, threadEntriesToMessages } from './legacy-adapter';",
        hint: 'legacy-adapter',
      },
      {
        // R2: 删除 threadToLegacyThread describe 块（位于文件尾）
        find:
          '\n\n' +
          nl([
            "describe('threadToLegacyThread', () => {",
            "  it('inverts legacyThreadToThread meta + content', () => {",
            '    const thread: IAiConversationThread = {',
            "      id: 'th1',",
            "      title: 'T',",
            "      titleStatus: 'temporary',",
            "      createdAt: '2026-01-01T00:00:00.000Z',",
            "      updatedAt: '2026-01-01T00:00:02.000Z',",
            '      messages: [userMessage, assistantMessage],',
            '    };',
            '    const back = threadToLegacyThread(legacyThreadToThread(thread));',
            "    expect(back.id).toBe('th1');",
            "    expect(back.title).toBe('T');",
            "    expect(back.messages.map((m) => m.role)).toEqual(['user', 'assistant']);",
            "    expect(back.messages[1]!.content).toBe('world');",
            '  });',
            '});',
          ]) +
          '\n',
        replace: '\n',
        goneToken: "describe('threadToLegacyThread'",
        hint: 'threadToLegacyThread',
      },
    ],
  },
];

run(BASE, files);