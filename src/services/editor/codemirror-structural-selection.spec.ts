import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  structuralSelectionEffect,
  structuralSelectionHistoryField,
} from '@/services/editor/codemirror-structural-selection';

const createState = (head: number): EditorState =>
  EditorState.create({
    doc: 'hello world',
    selection: EditorSelection.cursor(head),
    extensions: [structuralSelectionHistoryField],
  });

describe('structuralSelectionHistoryField', () => {
  it('扩大时压入扩大前的选区', () => {
    let state = createState(2);
    state = state.update({
      selection: EditorSelection.range(0, 11),
      effects: structuralSelectionEffect.of('expand'),
    }).state;
    const stack = state.field(structuralSelectionHistoryField);
    expect(stack).toHaveLength(1);
    expect(stack[0].main.head).toBe(2);
  });

  it('缩小时弹出栈顶', () => {
    let state = createState(2);
    state = state.update({
      selection: EditorSelection.range(0, 11),
      effects: structuralSelectionEffect.of('expand'),
    }).state;
    state = state.update({
      selection: EditorSelection.cursor(2),
      effects: structuralSelectionEffect.of('shrink'),
    }).state;
    expect(state.field(structuralSelectionHistoryField)).toHaveLength(0);
  });

  it('手动选区变化会重置历史栈', () => {
    let state = createState(2);
    state = state.update({
      selection: EditorSelection.range(0, 11),
      effects: structuralSelectionEffect.of('expand'),
    }).state;
    state = state.update({ selection: EditorSelection.cursor(5) }).state;
    expect(state.field(structuralSelectionHistoryField)).toHaveLength(0);
  });

  it('无关事务(无选区/无文档变化)不影响历史栈', () => {
    let state = createState(2);
    state = state.update({
      selection: EditorSelection.range(0, 11),
      effects: structuralSelectionEffect.of('expand'),
    }).state;
    state = state.update({}).state;
    expect(state.field(structuralSelectionHistoryField)).toHaveLength(1);
  });
});
