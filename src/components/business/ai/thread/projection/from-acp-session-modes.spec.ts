import { describe, expect, it } from 'vitest';
import { applyAcpModeUpdate, parseAcpSessionModeState } from './from-acp-session-modes';

describe('parseAcpSessionModeState', () => {
  it('parses a well-formed ACP SessionModeState', () => {
    const state = parseAcpSessionModeState({
      currentModeId: 'code',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'code', name: 'Code', description: 'Full autonomy' },
      ],
    });
    expect(state).toEqual({
      currentModeId: 'code',
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'code', name: 'Code', description: 'Full autonomy' },
      ],
    });
  });

  it('falls back to the first mode when currentModeId is missing or unknown', () => {
    expect(
      parseAcpSessionModeState({
        currentModeId: 'ghost',
        availableModes: [{ id: 'ask', name: 'Ask' }],
      })?.currentModeId,
    ).toBe('ask');
    expect(
      parseAcpSessionModeState({
        availableModes: [{ id: 'ask', name: 'Ask' }],
      })?.currentModeId,
    ).toBe('ask');
  });

  it('drops malformed mode entries', () => {
    const state = parseAcpSessionModeState({
      currentModeId: 'code',
      availableModes: [
        { id: 'code', name: 'Code' },
        { id: '', name: 'Bad' },
        { name: 'NoId' },
        'nope',
        { id: 'plan' },
      ],
    });
    expect(state?.availableModes).toEqual([{ id: 'code', name: 'Code' }]);
  });

  it('returns null for non-objects, empty lists, or missing availableModes', () => {
    expect(parseAcpSessionModeState(null)).toBeNull();
    expect(parseAcpSessionModeState('modes')).toBeNull();
    expect(parseAcpSessionModeState({})).toBeNull();
    expect(parseAcpSessionModeState({ availableModes: [] })).toBeNull();
    expect(parseAcpSessionModeState({ availableModes: [{ id: '', name: '' }] })).toBeNull();
  });
});

describe('applyAcpModeUpdate', () => {
  const base = {
    currentModeId: 'ask',
    availableModes: [
      { id: 'ask', name: 'Ask' },
      { id: 'code', name: 'Code' },
    ],
  };

  it('updates currentModeId when the mode is available', () => {
    expect(applyAcpModeUpdate(base, 'code').currentModeId).toBe('code');
  });

  it('ignores unknown mode ids', () => {
    expect(applyAcpModeUpdate(base, 'ghost')).toBe(base);
  });
});
