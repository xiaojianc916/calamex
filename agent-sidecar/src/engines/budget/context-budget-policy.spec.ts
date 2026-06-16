import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET,
  DEFAULT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET,
  MIN_COMPACTION_CONTEXT_WINDOW_TOKENS,
  resolveContextBudgetDecision,
  resolveContextCompactionRemainingTokenBudget,
  retainRecentUserMessageTexts,
} from './context-budget-policy.js';
import type { TMastraChatMessage } from '../shared/types.js';

const createCapabilities = (overrides: {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
} = {}) => ({
  contextWindowTokens: overrides.contextWindowTokens ?? 128_000,
  maxOutputTokens: overrides.maxOutputTokens ?? 64_000,
});

test('resolveContextBudgetDecision follows Zed-style remaining-token headroom', () => {
  const decision = resolveContextBudgetDecision({
    projectedInputTokens: 24_000,
    capabilities: createCapabilities(),
  });

  assert.equal(decision.kind, 'compact_recommended');
  assert.equal(decision.availableInputTokens, 64_000);
  assert.equal(decision.remainingInputTokens, 40_000);
  assert.equal(decision.compactionRemainingTokenBudget, DEFAULT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET);
  assert.equal(decision.compactionSupported, true);
  assert.equal(decision.retainedUserMessageByteBudget, COMPACTION_RETAINED_USER_MESSAGES_BYTE_BUDGET);
});

test('resolveContextBudgetDecision stays within budget when enough headroom remains', () => {
  const decision = resolveContextBudgetDecision({
    projectedInputTokens: 10_000,
    capabilities: createCapabilities({
      contextWindowTokens: 200_000,
      maxOutputTokens: 20_000,
    }),
  });

  assert.equal(decision.kind, 'within_budget');
  assert.equal(decision.remainingInputTokens, 170_000);
});

test('resolveContextBudgetDecision warns instead of compacts for small context windows', () => {
  const decision = resolveContextBudgetDecision({
    projectedInputTokens: 35_000,
    capabilities: createCapabilities({
      contextWindowTokens: MIN_COMPACTION_CONTEXT_WINDOW_TOKENS - 1,
      maxOutputTokens: 8_000,
    }),
  });

  assert.equal(decision.kind, 'warn_context_limit');
  assert.equal(decision.compactionSupported, false);
});

test('resolveContextCompactionRemainingTokenBudget accepts positive env override only', () => {
  assert.equal(
    resolveContextCompactionRemainingTokenBudget({ AGENT_COMPACTION_REMAINING_TOKEN_BUDGET: '12000' }),
    12_000,
  );
  assert.equal(
    resolveContextCompactionRemainingTokenBudget({ AGENT_COMPACTION_REMAINING_TOKEN_BUDGET: '-1' }),
    DEFAULT_CONTEXT_COMPACTION_REMAINING_TOKEN_BUDGET,
  );
});

test('retainRecentUserMessageTexts keeps newest user text within byte budget', () => {
  const messages: TMastraChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ignored' },
    { role: 'user', content: 'second' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'third' },
        { type: 'image', image: 'file:///tmp/a.png' },
      ],
    },
  ];

  assert.deepEqual(retainRecentUserMessageTexts(messages, 11), ['second', 'third']);
  assert.deepEqual(retainRecentUserMessageTexts(messages, 5), ['third']);
});
