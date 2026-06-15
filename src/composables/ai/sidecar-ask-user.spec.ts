import { describe, expect, it } from 'vitest';

import {
  buildAskUserResumeRequest,
  extractPendingAskUser,
} from '@/composables/ai/sidecar-ask-user';
import type {
  IAgentSidecarResponsePayload,
  IAskUserQuestion,
  TAgentUiEvent,
} from '@/types/ai/sidecar';

const choiceQuestion: IAskUserQuestion = {
  questionId: 'q1',
  question: '选择一个方向？',
  header: '方向',
  type: 'choice',
  options: [
    { optionId: 'o1', label: '方案 A' },
    { optionId: 'o2', label: '方案 B' },
  ],
};

const textQuestion: IAskUserQuestion = {
  questionId: 'q2',
  question: '补充说明？',
  header: '说明',
  type: 'text',
  placeholder: '随便写点',
};

const makeResponse = (events: TAgentUiEvent[]): IAgentSidecarResponsePayload => ({
  sessionId: 'session-1',
  events,
  result: null,
});

describe('extractPendingAskUser', () => {
  it('returns null when there is no ask_user_required event', () => {
    expect(extractPendingAskUser(makeResponse([{ type: 'done', result: 'ok' }]))).toBeNull();
  });

  it('projects the first ask_user_required event into a pending gate', () => {
    const pending = extractPendingAskUser(
      makeResponse([
        { type: 'message_delta', text: 'thinking' },
        {
          type: 'ask_user_required',
          requestId: 'req-1',
          request: { kind: 'user_question', questions: [choiceQuestion, textQuestion] },
        },
      ]),
    );
    expect(pending).toEqual({
      requestId: 'req-1',
      questions: [choiceQuestion, textQuestion],
    });
  });

  it('picks the first when multiple ask_user_required events are present', () => {
    const pending = extractPendingAskUser(
      makeResponse([
        {
          type: 'ask_user_required',
          requestId: 'first',
          request: { kind: 'user_question', questions: [choiceQuestion] },
        },
        {
          type: 'ask_user_required',
          requestId: 'second',
          request: { kind: 'user_question', questions: [textQuestion] },
        },
      ]),
    );
    expect(pending?.requestId).toBe('first');
  });
});

describe('buildAskUserResumeRequest', () => {
  it('includes answers for a selected outcome', () => {
    const request = buildAskUserResumeRequest({
      requestId: 'req-1',
      result: {
        outcome: 'selected',
        answers: [{ questionId: 'q1', optionIds: ['o1'] }],
      },
    });
    expect(request).toEqual({
      requestId: 'req-1',
      outcome: 'selected',
      answers: [{ questionId: 'q1', optionIds: ['o1'] }],
    });
  });

  it('omits answers for a cancelled outcome', () => {
    const request = buildAskUserResumeRequest({
      requestId: 'req-1',
      result: { outcome: 'cancelled' },
    });
    expect(request).toEqual({ requestId: 'req-1', outcome: 'cancelled' });
    expect('answers' in request).toBe(false);
  });

  it('omits answers when a selected outcome carries none', () => {
    const request = buildAskUserResumeRequest({
      requestId: 'req-1',
      result: { outcome: 'selected' },
    });
    expect('answers' in request).toBe(false);
  });

  it('includes sessionId only when provided', () => {
    expect(
      'sessionId' in
        buildAskUserResumeRequest({
          requestId: 'req-1',
          result: { outcome: 'cancelled' },
          sessionId: null,
        }),
    ).toBe(false);
    expect(
      buildAskUserResumeRequest({
        requestId: 'req-1',
        result: { outcome: 'cancelled' },
        sessionId: 'session-1',
      }).sessionId,
    ).toBe('session-1');
  });
});
