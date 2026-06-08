import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveContextManagementStrategy } from './context-strategy-policy.js';

test('resolveContextManagementStrategy does not compact while the request is within budget', () => {
  const strategy = resolveContextManagementStrategy({
    contextBudgetDecision: 'within_budget',
    mastraMemoryEnabled: true,
    observationalMemoryEnabled: true,
    semanticRecallEnabled: true,
  });

  assert.equal(strategy.owner, 'none');
  assert.equal(strategy.shouldRunZedStyleCompaction, false);
  assert.equal(strategy.shouldRelyOnMastraMemory, true);
});

test('resolveContextManagementStrategy prefers Mastra observational memory over custom compaction', () => {
  const strategy = resolveContextManagementStrategy({
    contextBudgetDecision: 'compact_recommended',
    mastraMemoryEnabled: true,
    observationalMemoryEnabled: true,
    semanticRecallEnabled: false,
  });

  assert.equal(strategy.owner, 'mastra_memory');
  assert.equal(strategy.shouldRunZedStyleCompaction, false);
  assert.equal(strategy.shouldRelyOnMastraMemory, true);
  assert.match(strategy.reason, /Observational Memory/u);
});

test('resolveContextManagementStrategy prefers Mastra semantic recall when observational memory is disabled', () => {
  const strategy = resolveContextManagementStrategy({
    contextBudgetDecision: 'compact_recommended',
    mastraMemoryEnabled: true,
    observationalMemoryEnabled: false,
    semanticRecallEnabled: true,
  });

  assert.equal(strategy.owner, 'mastra_memory');
  assert.equal(strategy.shouldRunZedStyleCompaction, false);
  assert.equal(strategy.shouldRelyOnMastraMemory, true);
  assert.match(strategy.reason, /Semantic Recall/u);
});

test('resolveContextManagementStrategy uses Zed-style compaction only as fallback', () => {
  const strategy = resolveContextManagementStrategy({
    contextBudgetDecision: 'compact_recommended',
    mastraMemoryEnabled: false,
    observationalMemoryEnabled: false,
    semanticRecallEnabled: false,
  });

  assert.equal(strategy.owner, 'zed_style_compaction');
  assert.equal(strategy.shouldRunZedStyleCompaction, true);
  assert.equal(strategy.shouldRelyOnMastraMemory, false);
});

test('resolveContextManagementStrategy warns for models too small for compaction', () => {
  const strategy = resolveContextManagementStrategy({
    contextBudgetDecision: 'warn_context_limit',
    mastraMemoryEnabled: true,
    observationalMemoryEnabled: false,
    semanticRecallEnabled: false,
  });

  assert.equal(strategy.owner, 'runtime_warning');
  assert.equal(strategy.shouldRunZedStyleCompaction, false);
  assert.equal(strategy.shouldRelyOnMastraMemory, true);
});
