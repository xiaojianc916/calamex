import { EditorState } from '@codemirror/state';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  parserInit: vi.fn(),
  languageLoad: vi.fn(),
  parserDelete: vi.fn(),
  treeDelete: vi.fn(),
  treeEdit: vi.fn(),
  parserSetLanguage: vi.fn(),
  parserParse: vi.fn(),
  listShellCommandLabels: vi.fn(),
}));

vi.mock('tree-sitter-bash/tree-sitter-bash.wasm?url', () => ({
  default: '/mock/tree-sitter-bash.wasm',
}));

vi.mock('web-tree-sitter/web-tree-sitter.wasm?url', () => ({
  default: '/mock/web-tree-sitter.wasm',
}));

vi.mock('@/services/shell/command-catalog', () => ({
  listShellCommandLabels: mocks.listShellCommandLabels,
}));

vi.mock('web-tree-sitter', () => {
  class MockParser {
    static init = mocks.parserInit;

    setLanguage = mocks.parserSetLanguage;

    parse(source: string, previousTree?: unknown) {
      return mocks.parserParse(source, previousTree);
    }

    delete = mocks.parserDelete;
  }

  return {
    Parser: MockParser,
    Language: {
      load: mocks.languageLoad,
    },
  };
});

const createTree = (source: string) => {
  const rootNode = {
    type: 'program',
    text: source,
    parent: null,
    parseState: 0,
    nextParseState: 0,
    endIndex: source.length,
    namedDescendantForPosition: () => null,
    descendantForPosition: () => null,
    descendantsOfType: () => [],
    childForFieldName: () => null,
  };

  return {
    rootNode,
    edit: mocks.treeEdit,
    delete: mocks.treeDelete,
  };
};

const createSource = () => {
  const completionContextBase = { explicit: true, aborted: false };
  return async (doc: string, pos: number) => {
    const { createShellCodeMirrorCompletionSource } = await import('./shell-completion');
    const source = createShellCodeMirrorCompletionSource();
    const state = EditorState.create({ doc });
    return source({ state, pos, ...completionContextBase } as never);
  };
};

describe('shell-completion provider', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.parserInit.mockReset();
    mocks.languageLoad.mockReset();
    mocks.parserDelete.mockReset();
    mocks.treeDelete.mockReset();
    mocks.treeEdit.mockReset();
    mocks.parserSetLanguage.mockReset();
    mocks.parserParse.mockReset();
    mocks.listShellCommandLabels.mockReset();

    mocks.parserParse.mockImplementation((source: string) => createTree(source));
    mocks.listShellCommandLabels.mockResolvedValue(['git']);
    mocks.languageLoad.mockResolvedValue({
      lookaheadIterator: () => null,
    });
  });

  it('Tree-sitter 初始化失败后，后续 CodeMirror 补全请求仍可重试恢复', async () => {
    mocks.parserInit
      .mockRejectedValueOnce(new Error('tree-sitter init failed'))
      .mockResolvedValue(undefined);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { createShellCodeMirrorCompletionSource } = await import('./shell-completion');
    const source = createShellCodeMirrorCompletionSource();
    const state = EditorState.create({ doc: 'gi' });

    await expect(
      source({ state, pos: 2, explicit: true, aborted: false } as never),
    ).resolves.toBeNull();

    const recovered = await source({ state, pos: 2, explicit: true, aborted: false } as never);

    expect(mocks.parserInit).toHaveBeenCalledTimes(2);
    expect(recovered?.options.some((entry) => entry.label === 'git')).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Shell completion provider failed',
      expect.any(Error),
    );
  });

  it('相同源文本的连续补全复用语法树，不重复解析', async () => {
    mocks.parserInit.mockResolvedValue(undefined);
    const runCompletion = createSource();

    await runCompletion('git', 3);
    await runCompletion('git', 3);

    expect(mocks.parserParse).toHaveBeenCalledTimes(1);
    expect(mocks.treeEdit).not.toHaveBeenCalled();
  });

  it('源文本变化时执行增量解析并携带上一棵语法树', async () => {
    mocks.parserInit.mockResolvedValue(undefined);
    const runCompletion = createSource();

    await runCompletion('gi', 2);
    await runCompletion('git', 3);

    expect(mocks.parserParse).toHaveBeenCalledTimes(2);
    expect(mocks.treeEdit).toHaveBeenCalledTimes(1);
    const previousTreeArgument = mocks.parserParse.mock.calls[1][1];
    expect(previousTreeArgument).toBe(mocks.parserParse.mock.results[0].value);
  });

  it('模糊匹配可命中非前缀候选（如 "gt" → "git"）', async () => {
    mocks.parserInit.mockResolvedValue(undefined);
    const runCompletion = createSource();

    const result = await runCompletion('gt', 2);

    expect(result?.options.some((entry) => entry.label === 'git')).toBe(true);
  });
});

describe('appendAliasEntries', () => {
  it('将别名展开为独立候选，且别名不继承插入文本、优先级排在规范名之后', async () => {
    const { appendAliasEntries } = await import('./shell-completion');

    const primaryEntry = {
      label: 'install',
      kind: 'command' as const,
      detail: '安装依赖 · 别名: i, add',
      insertText: 'install',
      insertAsSnippet: true,
      priority: 6,
    };
    const entries = appendAliasEntries(primaryEntry, '安装依赖', ['i', 'add']);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toBe(primaryEntry);

    const aliasLabels = entries.slice(1).map((entry) => entry.label);
    expect(aliasLabels).toEqual(['i', 'add']);

    for (const aliasEntry of entries.slice(1)) {
      expect(aliasEntry.kind).toBe('command');
      expect(aliasEntry.priority).toBe(6.5);
      expect(aliasEntry.insertText).toBeUndefined();
      expect(aliasEntry.insertAsSnippet).toBeUndefined();
      expect(aliasEntry.detail).toContain('install 的别名');
    }
  });

  it('无别名时原样返回规范名候选', async () => {
    const { appendAliasEntries } = await import('./shell-completion');

    const primaryEntry = {
      label: 'status',
      kind: 'command' as const,
      detail: '查看状态',
      priority: 6,
    };
    const entries = appendAliasEntries(primaryEntry, '查看状态', []);

    expect(entries).toEqual([primaryEntry]);
  });
});

describe('getUtf8ByteLength', () => {
  it('与 TextEncoder 的字节长度保持一致', async () => {
    const { getUtf8ByteLength } = await import('./shell-completion');
    const encoder = new TextEncoder();
    const samples = [
      '',
      'ls -la',
      '查看当前目录',
      'echo 🙂 done',
      'café',
      'a\nb\tc',
      '混合 mixed 文本 123',
    ];

    for (const sample of samples) {
      expect(getUtf8ByteLength(sample)).toBe(encoder.encode(sample).byteLength);
    }
  });
});
