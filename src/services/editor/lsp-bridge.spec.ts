import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { buildLspContentChanges } from './lsp-bridge';

describe('buildLspContentChanges', () => {
  it('把单行替换转换为 LSP UTF-16 range', () => {
    const state = EditorState.create({ doc: 'echo old\n' });
    const transaction = state.update({ changes: { from: 5, to: 8, insert: 'new' } });
    expect(
      buildLspContentChanges({
        changes: transaction.changes,
        startState: state,
      }),
    ).toEqual([
      {
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 8 },
        },
        rangeLength: 3,
        text: 'new',
      },
    ]);
  });

  it('把跨行删除转换为基于旧文档的 LSP range', () => {
    const state = EditorState.create({ doc: 'one\ntwo\nthree\n' });
    const transaction = state.update({ changes: { from: 2, to: 9, insert: 'X' } });
    expect(
      buildLspContentChanges({
        changes: transaction.changes,
        startState: state,
      }),
    ).toEqual([
      {
        range: {
          start: { line: 0, character: 2 },
          end: { line: 2, character: 0 },
        },
        rangeLength: 7,
        text: 'X',
      },
    ]);
  });
});
