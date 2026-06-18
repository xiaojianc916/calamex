#!/usr/bin/env node
// Align the IPC wire types (ITauriService + aiService) to the tauri-specta
// generated bindings (@/bindings/tauri), per ADR-0015 "Rust = single source of
// truth". For the 9 AI commands whose generated payloads are wider than the
// handwritten @/types/ai mirrors (providerType / confidence / classification /
// web enums = string; web recency & applyPatch metadata = `| null` vs optional)
// this swaps the boundary in/out types to the generated ones and removes the
// now-redundant narrow mirror imports. UI-internal literal-union / zod domain
// types are intentionally left untouched (they keep driving selectors, exhaustive
// switches and *.schema.spec.ts).
//
// Idempotent + EOL-tolerant. Run from repo root:
//   node scripts/acp-align-ipc-wire-types.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const BINDINGS_MODULE = '@/bindings/tauri';

const GENERATED_NAMES = [
  'AiAgentClassifyTaskPayload',
  'AiApplyPatchRequest',
  'AiChatStreamPayload',
  'AiConfigPayload',
  'AiInlineCompletionResult',
  'AiProviderConnectionPayload',
  'AiWebSearchInput',
  'AiWebSearchPayload',
];

const NARROW_IMPORTS_TO_REMOVE = [
  'IAiAgentClassifyTaskPayload',
  'IAiApplyPatchRequest',
  'IAiChatStreamPayload',
  'IAiConfigPayload',
  'IAiInlineCompletionResult',
  'IAiProviderConnectionPayload',
  'IAiWebSearchInput',
  'IAiWebSearchPayload',
];

const TYPES_FILE = 'src/types/tauri/index.ts';
const SERVICE_FILE = 'src/services/ipc/ai.service.ts';

// Interface declarations (ITauriService) end with `;`.
const TYPES_EDITS = [
  ['aiGetConfig(): Promise<IAiConfigPayload>;', 'aiGetConfig(): Promise<AiConfigPayload>;'],
  ['aiSaveConfig(payload: IAiSaveConfigRequest): Promise<IAiConfigPayload>;', 'aiSaveConfig(payload: IAiSaveConfigRequest): Promise<AiConfigPayload>;'],
  ['aiSaveCredentials(payload: IAiSaveCredentialsRequest): Promise<IAiConfigPayload>;', 'aiSaveCredentials(payload: IAiSaveCredentialsRequest): Promise<AiConfigPayload>;'],
  ['aiConnectProvider(payload: IAiProviderConnectionRequest): Promise<IAiProviderConnectionPayload>;', 'aiConnectProvider(payload: IAiProviderConnectionRequest): Promise<AiProviderConnectionPayload>;'],
  ['aiChatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload>;', 'aiChatStream(payload: IAiChatRequest): Promise<AiChatStreamPayload>;'],
  ['aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult>;', 'aiInlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult>;'],
  ['aiAgentClassifyTask(payload: IAiAgentClassifyTaskRequest): Promise<IAiAgentClassifyTaskPayload>;', 'aiAgentClassifyTask(payload: IAiAgentClassifyTaskRequest): Promise<AiAgentClassifyTaskPayload>;'],
  ['aiWebSearch(payload: IAiWebSearchInput): Promise<IAiWebSearchPayload>;', 'aiWebSearch(payload: AiWebSearchInput): Promise<AiWebSearchPayload>;'],
  ['aiApplyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload>;', 'aiApplyPatch(payload: AiApplyPatchRequest): Promise<IAiApplyPatchPayload>;'],
];

// Implementation methods (aiService) open with ` {`.
const SERVICE_EDITS = [
  ['getConfig(): Promise<IAiConfigPayload> {', 'getConfig(): Promise<AiConfigPayload> {'],
  ['saveConfig(payload: IAiSaveConfigRequest): Promise<IAiConfigPayload> {', 'saveConfig(payload: IAiSaveConfigRequest): Promise<AiConfigPayload> {'],
  ['saveCredentials(payload: IAiSaveCredentialsRequest): Promise<IAiConfigPayload> {', 'saveCredentials(payload: IAiSaveCredentialsRequest): Promise<AiConfigPayload> {'],
  ['connectProvider(payload: IAiProviderConnectionRequest): Promise<IAiProviderConnectionPayload> {', 'connectProvider(payload: IAiProviderConnectionRequest): Promise<AiProviderConnectionPayload> {'],
  ['chatStream(payload: IAiChatRequest): Promise<IAiChatStreamPayload> {', 'chatStream(payload: IAiChatRequest): Promise<AiChatStreamPayload> {'],
  ['inlineComplete(payload: IAiInlineCompletionRequest): Promise<IAiInlineCompletionResult> {', 'inlineComplete(payload: IAiInlineCompletionRequest): Promise<AiInlineCompletionResult> {'],
  ['classifyTask(payload: IAiAgentClassifyTaskRequest): Promise<IAiAgentClassifyTaskPayload> {', 'classifyTask(payload: IAiAgentClassifyTaskRequest): Promise<AiAgentClassifyTaskPayload> {'],
  ['webSearch(payload: IAiWebSearchInput): Promise<IAiWebSearchPayload> {', 'webSearch(payload: AiWebSearchInput): Promise<AiWebSearchPayload> {'],
  ['applyPatch(payload: IAiApplyPatchRequest): Promise<IAiApplyPatchPayload> {', 'applyPatch(payload: AiApplyPatchRequest): Promise<IAiApplyPatchPayload> {'],
];

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');

const buildGeneratedImport = (eol) => {
  const lines = ['import type {'];
  for (const name of GENERATED_NAMES) {
    lines.push(`  ${name},`);
  }
  lines.push(`} from '${BINDINGS_MODULE}';`);
  return lines.join(eol);
};

const applyEdit = (text, [from, to]) => {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly 1 occurrence, found ${count}: ${from}`);
  }
  return text.replace(from, () => to);
};

const removeNarrowImportLines = (text) => {
  let next = text;
  for (const name of NARROW_IMPORTS_TO_REMOVE) {
    const re = new RegExp(`[^\\S\\r\\n]*${name},\\r?\\n`);
    if (!re.test(next)) {
      throw new Error(`narrow import line not found: ${name}`);
    }
    next = next.replace(re, '');
  }
  return next;
};

const migrate = (file, edits) => {
  const original = readFileSync(file, 'utf8');
  if (original.includes(`from '${BINDINGS_MODULE}'`)) {
    console.log(`skip (already migrated): ${file}`);
    return;
  }
  const eol = detectEol(original);
  let next = removeNarrowImportLines(original);
  next = `${buildGeneratedImport(eol)}${eol}${next}`;
  for (const edit of edits) {
    next = applyEdit(next, edit);
  }
  writeFileSync(file, next);
  console.log(`migrated: ${file}`);
};

migrate(TYPES_FILE, TYPES_EDITS);
migrate(SERVICE_FILE, SERVICE_EDITS);
