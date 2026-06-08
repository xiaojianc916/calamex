import assert from 'node:assert/strict';
import test from 'node:test';

import { createAcontextTokenEventDraft } from './budget.js';
import type { IMastraToolBudgetStats, TMastraChatMessage } from '../types.js';

const emptyToolStats: IMastraToolBudgetStats = {
  toolCount: 0,
  mcpToolCount: 0,
  mcpServerCount: 0,
  uiContextToolCount: 0,
  nativeToolCount: 0,
  logToolCount: 0,
  toolSchemaCharCount: 0,
  mcpServerNames: [],
  toolLoadStrategy: 'none',
};

const createLongMessage = (): TMastraChatMessage => ({
  role: 'user',
  content: 'x'.repeat(220_000),
});

const createTokenEventDraft = (input: {
  readonly memoryEnabled: boolean;
  readonly observationalMemoryEnabled: boolean;
  readonly semanticRecallEnabled: boolean;
}) => createAcontextTokenEventDraft({
  systemPrompt: '',
  messages: [createLongMessage()],
  contextReferences: [],
  tools: {},
  toolStats: emptyToolStats,
  workspaceEnabled: false,
  browserEnabled: false,
  memoryEnabled: input.memoryEnabled,
  observationalMemoryEnabled: input.observationalMemoryEnabled,
  semanticRecallEnabled: input.semanticRecallEnabled,
  maxSteps: 1,
  toolChoice: 'none',
  modelCapabilities: {
    contextWindowTokens: 128_000,
    maxOutputTokens: 64_000,
  },
});

test('createAcontextTokenEventDraft marks Mastra memory as context owner when observational memory is enabled', () => {
  const draft = createTokenEventDraft({
    memoryEnabled: true,
    observationalMemoryEnabled: true,
    semanticRecallEnabled: false,
  });

  assert.equal(draft.contextBudgetDecision, 'compact_recommended');
  assert.equal(draft.contextManagementOwner, 'mastra_memory');
  assert.equal(draft.shouldRunZedStyleCompaction, false);
  assert.equal(draft.shouldRelyOnMastraMemory, true);
  assert.equal(draft.observationalMemoryEnabled, true);
});

test('createAcontextTokenEventDraft falls back to Zed-style compaction without Mastra long-context memory', () => {
  const draft = createTokenEventDraft({
    memoryEnabled: false,
    observationalMemoryEnabled: false,
    semanticRecallEnabled: false,
  });

  assert.equal(draft.contextBudgetDecision, 'compact_recommended');
  assert.equal(draft.contextManagementOwner, 'zed_style_compaction');
  assert.equal(draft.shouldRunZedStyleCompaction, true);
  assert.equal(draft.shouldRelyOnMastraMemory, false);
});
