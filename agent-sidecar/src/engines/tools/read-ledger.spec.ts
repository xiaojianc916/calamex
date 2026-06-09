import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWorkspaceReadLedger } from './read-ledger.js';

test('read ledger 记录后同 mtime 视为新鲜', () => {
	const ledger = createWorkspaceReadLedger();
	assert.equal(ledger.isFresh('a.ts', 100), false);
	ledger.record('a.ts', 100);
	assert.equal(ledger.isFresh('a.ts', 100), true);
});

test('read ledger mtime 变化后不再新鲜', () => {
	const ledger = createWorkspaceReadLedger();
	ledger.record('a.ts', 100);
	assert.equal(ledger.isFresh('a.ts', 200), false);
});

test('read ledger 按路径隔离', () => {
	const ledger = createWorkspaceReadLedger();
	ledger.record('a.ts', 100);
	assert.equal(ledger.isFresh('b.ts', 100), false);
});
