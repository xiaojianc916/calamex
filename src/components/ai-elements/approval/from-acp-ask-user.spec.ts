import { describe, expect, it } from 'vitest';

import { buildAcpAskUserQuestions, resolveAcpDecisionFromAskUserResult } from './from-acp-ask-user';
import type { IAcpPermissionRequest } from './from-acp-permission';

const baseRequest = (
  options: IAcpPermissionRequest['options'],
  toolCall?: unknown,
): IAcpPermissionRequest => ({
  sessionId: 'sess-1',
  toolCallId: 'tool-1',
  options,
  toolCall,
});

describe('buildAcpAskUserQuestions', () => {
  it('returns null for a standard tool permission', () => {
    const request = baseRequest([
      { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'allow-always', name: '总是允许', kind: 'allow_always' },
      { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
    ]);
    expect(buildAcpAskUserQuestions(request)).toBeNull();
  });

  it('detects a multi-choice ask-user via the allow_once heuristic and maps options verbatim', () => {
    const request = baseRequest([
      { optionId: 'opt-tp', name: '瞬间移动', kind: 'allow_once' },
      { optionId: 'opt-tt', name: '时间旅行', kind: 'allow_once' },
      { optionId: 'opt-mr', name: '读心术', kind: 'allow_once' },
      { optionId: 'opt-skip', name: 'Skip', kind: 'reject_once' },
    ]);
    const questions = buildAcpAskUserQuestions(request);
    if (!questions) {
      throw new Error('expected ask-user questions');
    }
    expect(questions).toHaveLength(1);
    const [question] = questions;
    expect(question.questionId).toBe('tool-1');
    expect(question.type).toBe('choice');
    expect(question.multiSelect).toBe(false);
    expect(question.options).toEqual([
      { optionId: 'opt-tp', label: '瞬间移动' },
      { optionId: 'opt-tt', label: '时间旅行' },
      { optionId: 'opt-mr', label: '读心术' },
    ]);
  });

  it('recovers the real question text and header from toolCall.rawInput', () => {
    const request = baseRequest(
      [
        { optionId: 'opt-a', name: 'A', kind: 'allow_once' },
        { optionId: 'opt-skip', name: 'Skip', kind: 'reject_once' },
      ],
      {
        title: '请选择一个超能力',
        rawInput: {
          questions: [{ question: '你想要哪种超能力？', header: '超能力', multiSelect: true }],
        },
      },
    );
    const questions = buildAcpAskUserQuestions(request);
    if (!questions) {
      throw new Error('expected ask-user questions');
    }
    const [question] = questions;
    expect(question.question).toBe('你想要哪种超能力？');
    expect(question.header).toBe('超能力');
    expect(question.multiSelect).toBe(false);
  });
});

describe('resolveAcpDecisionFromAskUserResult', () => {
  const request = baseRequest([
    { optionId: 'opt-a', name: 'A', kind: 'allow_once' },
    { optionId: 'opt-b', name: 'B', kind: 'allow_once' },
    { optionId: 'opt-skip', name: 'Skip', kind: 'reject_once' },
  ]);

  it('returns the selected optionId verbatim', () => {
    const decision = resolveAcpDecisionFromAskUserResult(request, {
      outcome: 'selected',
      answers: [{ questionId: 'tool-1', optionIds: ['opt-b'] }],
    });
    expect(decision).toBe('opt-b');
  });

  it('falls back to the reject option when cancelled', () => {
    expect(resolveAcpDecisionFromAskUserResult(request, { outcome: 'cancelled' })).toBe('opt-skip');
  });

  it('falls back to the reject option when only free text is provided', () => {
    const decision = resolveAcpDecisionFromAskUserResult(request, {
      outcome: 'selected',
      answers: [{ questionId: 'tool-1', optionIds: [], text: '自定义' }],
    });
    expect(decision).toBe('opt-skip');
  });

  it('returns null when there is no reject option to decline with', () => {
    const noReject = baseRequest([
      { optionId: 'opt-a', name: 'A', kind: 'allow_once' },
      { optionId: 'opt-b', name: 'B', kind: 'allow_once' },
    ]);
    expect(resolveAcpDecisionFromAskUserResult(noReject, { outcome: 'cancelled' })).toBeNull();
  });
});
