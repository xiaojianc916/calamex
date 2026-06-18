#!/usr/bin/env node
// Increment to scripts/acp-align-ipc-wire-types.mjs (already applied): also
// repoints the aiAgentSetNetworkPermission RETURN type at the IPC boundary to
// the tauri-specta generated binding `AiAgentNetworkPermissionPayload`
// (permission: string) instead of the narrow @/types/ai mirror
// `IAiAgentNetworkPermissionPayload` (permission: 'off' | 'ask' |
// 'allowed-this-run'). The narrow *request* type is left as-is (the generated
// command input is structurally compatible). UI-internal literal-union / zod
// domain types stay untouched.
//
// Idempotent + EOL-tolerant. Run from repo root:
//   node scripts/acp-align-ipc-agent-network-permission.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const FILES = ['src/types/tauri/index.ts', 'src/services/ipc/ai.service.ts'];

// Alphabetical insertion point inside the existing `@/bindings/tauri` import
// block (AiAgentClassifyTaskPayload < AiAgentNetworkPermissionPayload < AiApplyPatchRequest).
const BINDINGS_BLOCK_ANCHOR = '  AiAgentClassifyTaskPayload,';
const NARROW_IMPORT = 'IAiAgentNetworkPermissionPayload';
const NARROW_RETURN = 'Promise<IAiAgentNetworkPermissionPayload>';
const GENERATED_RETURN = 'Promise<AiAgentNetworkPermissionPayload>';

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

const applyEdit = (text, from, to) => {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly 1 occurrence, found ${count}: ${from}`);
  }
  return text.replace(from, () => to);
};

const migrate = (file) => {
  const original = readFileSync(file, 'utf8');
  if (original.includes(GENERATED_RETURN)) {
    console.log(`skip (already migrated): ${file}`);
    return;
  }
  const eol = detectEol(original);
  let next = original;

  // 1. Add the generated payload to the existing @/bindings/tauri import block.
  next = applyEdit(
    next,
    BINDINGS_BLOCK_ANCHOR,
    `${BINDINGS_BLOCK_ANCHOR}${eol}  AiAgentNetworkPermissionPayload,`,
  );

  // 2. Drop the now-unused narrow mirror import line.
  const removeRe = new RegExp(`[^\\S\\r\\n]*${NARROW_IMPORT},\\r?\\n`);
  if (!removeRe.test(next)) {
    throw new Error(`narrow import line not found: ${NARROW_IMPORT}`);
  }
  next = next.replace(removeRe, '');

  // 3. Repoint the return type.
  next = applyEdit(next, NARROW_RETURN, GENERATED_RETURN);

  writeFileSync(file, next);
  console.log(`migrated: ${file}`);
};

for (const file of FILES) {
  migrate(file);
}
