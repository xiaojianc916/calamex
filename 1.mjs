// scripts/fix-stale-tests-tierA.mjs
// 一次性 codemod：修复「重构后测试没跟上」的 17 个陈旧测试失败（8 个文件，纯测试改动、可逆）。
// 每条编辑都以源码实读锚定；锚点缺失即抛错（守卫式，宁可失败也不静默误改）。
// 用法：node scripts/fix-stale-tests-tierA.mjs   （在仓库根目录）
import { readFileSync, writeFileSync } from 'node:fs';

const L = (...lines) => lines.join('\n');
let changed = 0;

function patch(file, edits) {
  const original = readFileSync(file, 'utf8');
  let text = original;
  for (const { find, replace, count = 1 } of edits) {
    const occurrences = text.split(find).length - 1;
    if (occurrences !== count) {
      throw new Error(
        `[${file}] 锚点匹配数=${occurrences}，期望=${count}。文件可能已改动或已打过补丁。锚点片段：\n${find.slice(0, 80)}…`,
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

// 1) github-auth.store.spec.ts —— mock 路径点写成斜杠
patch('src/domains/git/state/github-auth.store.spec.ts', [
  {
    find: "vi.mock('@/services/tauri.github-auth', () => ({",
    replace: "vi.mock('@/services/tauri/github-auth', () => ({",
  },
]);

// 2) useWindowResizeState.spec.ts —— 模拟 ResizeObserver observe() 的初始回调
patch('src/composables/useWindowResizeState.spec.ts', [
  {
    find: L('    capturedCallback = callback;', '    return { stop: vi.fn() };'),
    replace: L(
      '    capturedCallback = callback;',
      '    // 真实 ResizeObserver 在 observe() 时立即回调一次初始尺寸，被 composable 用',
      '    // hasSeenInitialObservation 跳过；mock 必须模拟它，否则首个 fireResize() 会被当初始帧吞掉。',
      '    callback();',
      '    return { stop: vi.fn() };',
    ),
  },
]);

// 3) bash-runtime.spec.ts —— 仅在真实码点边界校验互逆
patch('src/services/editor/tree-sitter/bash-runtime.spec.ts', [
  {
    find: L(
      "  it('与 getUtf8ByteLength 互为逆运算(字符边界处)', () => {",
      "    const source = 'a中b😀c';",
      '    for (let charIndex = 0; charIndex <= source.length; charIndex += 1) {',
      '      const byteOffset = utf8ByteLengthOfRange(source, 0, charIndex);',
      '      expect(byteOffsetToCharIndex(source, byteOffset)).toBe(charIndex);',
      '    }',
      '  });',
    ),
    replace: L(
      "  it('与 getUtf8ByteLength 互为逆运算(字符边界处)', () => {",
      "    const source = 'a中b😀c';",
      '    // 用 for...of 按码点推进，跳过代理对内部的 UTF-16 码元中点（那里孤立高代理按 3 字节计，',
      '    // 与逆函数吃掉整对的 4 字节本就不互逆，属预期语义而非缺陷）。',
      '    let charIndex = 0;',
      '    for (const codePoint of source) {',
      '      const byteOffset = utf8ByteLengthOfRange(source, 0, charIndex);',
      '      expect(byteOffsetToCharIndex(source, byteOffset)).toBe(charIndex);',
      '      charIndex += codePoint.length;',
      '    }',
      '    const totalBytes = utf8ByteLengthOfRange(source, 0, source.length);',
      '    expect(byteOffsetToCharIndex(source, totalBytes)).toBe(source.length);',
      '  });',
    ),
  },
]);

// 4) shell-completion.spec.ts —— web-tree-sitter mock 补 Edit 导出
patch('src/domains/terminal/utils/shell-completion.spec.ts', [
  {
    find: L(
      '  return {',
      '    Parser: MockParser,',
      '    Language: {',
      '      load: mocks.languageLoad,',
      '    },',
      '  };',
    ),
    replace: L(
      '  class MockEdit {',
      '    constructor(init: Record<string, unknown>) {',
      '      Object.assign(this, init);',
      '    }',
      '  }',
      '',
      '  return {',
      '    Parser: MockParser,',
      '    Language: {',
      '      load: mocks.languageLoad,',
      '    },',
      '    Edit: MockEdit,',
      '  };',
    ),
  },
]);

// 5) AiChatThread.spec.ts —— after-message 插槽读 message-id（不再是 {message:{id}}）
patch('src/components/business/ai/chat/AiChatThread.spec.ts', [
  {
    count: 2,
    find: L(
      "        'after-message': (slotProps: { message: { id: string } }) =>",
      "          h('div', { class: 'after-msg', 'data-message-id': slotProps.message.id }, 'checkpoint'),",
    ),
    replace: L(
      "        'after-message': (slotProps: { messageId?: string; 'message-id'?: string }) =>",
      '          h(',
      "            'div',",
      '            {',
      "              class: 'after-msg',",
      "              'data-message-id': slotProps.messageId ?? slotProps['message-id'],",
      '            },',
      "            'checkpoint',",
      '          ),',
    ),
  },
]);

// 6) AiPromptInput.spec.ts —— sessionConfigOptions 判别联合（kind:'ready'）
patch('src/components/business/ai/chat/AiPromptInput.spec.ts', [
  {
    find: "import type { IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';",
    replace: "import type { TAcpSessionConfigOptions } from '@/types/ai/sidecar';",
  },
  {
    find: '  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;',
    replace: '  sessionConfigOptions?: TAcpSessionConfigOptions | null;',
  },
  {
    count: 2,
    find: L('    const sessionConfigOptions: IAcpSessionConfigOptionsState = {', '      configOptions: ['),
    replace: L(
      '    const sessionConfigOptions: TAcpSessionConfigOptions = {',
      "      kind: 'ready',",
      '      configOptions: [',
    ),
  },
  {
    find: 'const wrapper = mountPromptInput({ sessionConfigOptions: null });',
    replace: "const wrapper = mountPromptInput({ sessionConfigOptions: { kind: 'ready', configOptions: [] } });",
  },
]);

// 7) useAcpSessionConfigOptions.spec.ts —— 先握手建立 activeThreadId，set 回执才会并入
patch('src/composables/ai/useAcpSessionConfigOptions.spec.ts', [
  {
    find: L(
      '    const vm = withScope(() => useAcpSessionConfigOptions());',
      '    vm.applyConfigOptionUpdate(buildConfigOptions());',
      '',
      "    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');",
    ),
    replace: L(
      '    ensureAcpSession.mockResolvedValue({ configOptions: buildConfigOptions() });',
      '    const vm = withScope(() => useAcpSessionConfigOptions());',
      '    // activeThreadId 仅由 ensureAcpSession 建立；set 回执只在 activeThreadId===threadId 时并入。',
      '    // 故用握手建立会话，替代仅 applyConfigOptionUpdate 播种（后者不设 activeThreadId）。',
      "    await vm.ensureAcpSession('thread-1', 'kimi');",
      '',
      "    const ok = await vm.selectConfigOption('thread-1', 'model', 'k1');",
    ),
  },
]);

// 8) useAiConversationHistory.spec.ts —— 夹具/标签改为 entries 模型
patch('src/composables/ai/useAiConversationHistory.spec.ts', [
  {
    find: "import type { IAiChatMessage } from '@/types/ai';",
    replace: "import type { IAiThread } from '@/types/ai/thread';",
  },
  {
    find: L(
      'const createThread = (id: string, updatedAt: string, messageCount: number) => ({',
      '  id,',
      '  title: `会话 ${id}`,',
      '  createdAt: updatedAt,',
      '  updatedAt,',
      '  messages: Array.from({ length: messageCount }, () => ({}) as IAiChatMessage),',
      '});',
    ),
    replace: L(
      'const createThread = (id: string, updatedAt: string, messageCount: number): IAiThread =>',
      '  ({',
      '    id,',
      '    title: `会话 ${id}`,',
      '    createdAt: updatedAt,',
      '    updatedAt,',
      '    // entries-native：源码按 entries 里的 user_message/assistant_message 计数，不再读 thread.messages。',
      "    entries: Array.from({ length: messageCount }, () => ({ type: 'user_message' })),",
      '  }) as unknown as IAiThread;',
    ),
  },
  {
    find: "    expect(history.getHistoryMessageCountLabel([{}, {}] as IAiChatMessage[])).toBe('2 条消息');",
    replace: L(
      "    expect(history.getHistoryMessageCountLabel(createThread('x', '2026-06-09T10:00:00.000Z', 2))).toBe(",
      "      '2 条消息',",
      '    );',
    ),
  },
]);

console.log(`\nTier A 完成：改动 ${changed} 个文件（预期 8）。`);
console.log('接着跑：pnpm vitest run 上述 8 个 spec 验证；tsc 类型检查确保无悬空类型。');