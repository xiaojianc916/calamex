// scripts/fix-stale-tests-tierB.mjs
// Tier B：3 个文件、3 项修点（纯测试改动，可逆）。
// 1. integrated-terminal.state.spec.ts — 删除 normalizeTerminalAnsiForTheme 测试（函数已从源码移除）
// 2. aiThreadEntriesStorage.spec.ts    — data:image 测试追加真实计时等待（crypto.subtle.digest 宏任务）
// 3. services/tauri/index.spec.ts      — 删除 agentSidecarResolveApproval 测试（方法已从源码删除）
import { readFileSync, writeFileSync } from 'node:fs';

let changed = 0;

function patch(file, edits) {
  const original = readFileSync(file, 'utf8');
  let text = original;
  for (const { find, replace, count = 1 } of edits) {
    const occurrences = text.split(find).length - 1;
    if (occurrences !== count) {
      throw new Error(
        `[${file}] 锚点匹配数=${occurrences}，期望=${count}。\n` +
        `文件可能已改动或已打过补丁。锚点首 80 字符：\n${find.slice(0, 80)}…`,
      );
    }
    text = text.split(find).join(replace);
  }
  if (text !== original) {
    writeFileSync(file, text, 'utf8');
    changed += 1;
    console.log(`✓ patched ${file}`);
  } else {
    console.log(`= unchanged ${file}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 删除 normalizeTerminalAnsiForTheme 相关内容
//    范式判决：专业终端不改写 PTY 字节流；Calamex 已有 themed palette + minimumContrastRatio，
//    该函数的移除是有意重构，测试是遗留陈旧断言，直接删除。
// ─────────────────────────────────────────────────────────────────────────────
patch('src/composables/__tests__/integrated-terminal.state.spec.ts', [
  // 1a. 收拢 import，删掉已不存在的 normalizeTerminalAnsiForTheme
  {
    find: "import {\n  normalizeTerminalAnsiForTheme,\n  stripInjectedRunSeparatorForTerminalData,\n} from '@/domains/terminal/core/session';",
    replace: "import { stripInjectedRunSeparatorForTerminalData } from '@/domains/terminal/core/session';",
  },
  // 1b. 删除 it 测试块（含其前的一个空行，保留其后的空行，确保上下两个 it 间仍有一个空行）
  {
    find:
      '\n\n' +
      // String.raw 保留文件里的字面量 \x1b（4字符），避免在 .mjs 里误转成 ESC 字节
      String.raw`    it('浅色终端写入前移除强制白字与黑底 ANSI', () => {
      expect(normalizeTerminalAnsiForTheme('\x1b[37m[test@Predator]$\x1b[40m ', 'light')).toBe(
        '\x1b[39m[test@Predator]$\x1b[49m ',
      );
      expect(normalizeTerminalAnsiForTheme('\x1b[1;97;100m提示\x1b[0m', 'light')).toBe(
        '\x1b[1;39;49m提示\x1b[0m',
      );
      expect(normalizeTerminalAnsiForTheme('\x1b[38;5;37m保留索引色', 'light')).toBe(
        '\x1b[38;5;37m保留索引色',
      );
      expect(normalizeTerminalAnsiForTheme('\x1b[37m深色保留', 'dark')).toBe('\x1b[37m深色保留');
    });`,
    replace: '',
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 2. aiThreadEntriesStorage.spec.ts — data:image 测试追加真实计时等待
//    preparePersistValue 对 data:image 走 crypto.subtle.digest (libuv 线程池 → 宏任务)，
//    advanceTimersByTimeAsync 只冲洗微任务，落盘链未完成时就断言 → KEY undefined。
//    修法：驱动完假定时器后切回真实计时，用 vi.waitFor 轮询等待落盘链到位。
// ─────────────────────────────────────────────────────────────────────────────
patch('src/store/plugins/aiThreadEntriesStorage.spec.ts', [
  {
    find: "    mod.scheduleAiThreadEntriesPersist(snapshot);\n    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);\n\n    const written = idbMock.map.get(KEY);",
    replace: [
      "    mod.scheduleAiThreadEntriesPersist(snapshot);",
      "    await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS);",
      "",
      "    // data:image 抽取走 crypto.subtle.digest（libuv 线程池完成 → 宏任务回调），",
      "    // advanceTimersByTimeAsync 的微任务冲洗驱动不到它，落盘链仍挂起。",
      "    // 切回真实计时，用 vi.waitFor 轮询等待 idb.set 真正写入。",
      "    vi.useRealTimers();",
      "    await vi.waitFor(() => {",
      "      expect(idbMock.map.get(KEY)).toBeDefined();",
      "    });",
      "",
      "    const written = idbMock.map.get(KEY);",
    ].join('\n'),
  },
]);

// ─────────────────────────────────────────────────────────────────────────────
// 3. 删除 agentSidecarResolveApproval 测试块
//    该方法（原指向未注册的 builtin_agent_resolve_approval）在当前 main 的
//    ITauriService、sidecar.ts、ai.ts 里已完全不存在。
//    测试块是悬空引用，直接删除即可，无需改动任何产品源码。
// ─────────────────────────────────────────────────────────────────────────────
patch('src/services/tauri/index.spec.ts', [
  {
    find:
      "\n\n  it('agentSidecarResolveApproval 复用 sidecar 长任务超时预算', async () => {\n" +
      "    vi.useFakeTimers();\n" +
      "    invokeMock.mockImplementation(() => new Promise(() => undefined));\n" +
      "\n" +
      "    try {\n" +
      "      const sidecarTaskTimeoutMs = 30 * 60 * 1000;\n" +
      "      const promise = tauriService.agentSidecarResolveApproval({\n" +
      "        requestId: 'approval-request-1',\n" +
      "        decision: 'allow-once',\n" +
      "      });\n" +
      "\n" +
      "      let settled = false;\n" +
      "      void promise.then(\n" +
      "        () => {\n" +
      "          settled = true;\n" +
      "        },\n" +
      "        () => {\n" +
      "          settled = true;\n" +
      "        },\n" +
      "      );\n" +
      "\n" +
      "      await vi.advanceTimersByTimeAsync(30_001);\n" +
      "      expect(settled).toBe(false);\n" +
      "\n" +
      "      await vi.advanceTimersByTimeAsync(sidecarTaskTimeoutMs - 30_002);\n" +
      "      expect(settled).toBe(false);\n" +
      "\n" +
      "      await vi.advanceTimersByTimeAsync(1);\n" +
      "      await expect(promise).rejects.toMatchObject({\n" +
      "        code: 'ipc.timeout',\n" +
      "        scope: 'ipc',\n" +
      "      });\n" +
      "    } finally {\n" +
      "      vi.useRealTimers();\n" +
      "    }\n" +
      "  });",
    replace: '',
  },
]);

console.log(`\nTier B 完成：改动 ${changed} 个文件（预期 3）。`);