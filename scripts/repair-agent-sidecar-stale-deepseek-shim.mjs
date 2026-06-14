import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'agent-sidecar/src/engines/chat/chat.ts',
  'agent-sidecar/src/engines/approval-client/client.ts',
];

const staleNames = [
  'createDeepSeekPayloadEventSink',
  'runWithDeepSeekReasoningContext',
  'createDeepSeekReasoningRunPrefix',
  'evictDeepSeekReasoningByPrefix',
  'deepseek-reasoning-fetch',
];

const read = (path) => readFileSync(path, 'utf8');

const writeIfChanged = (path, next, prev) => {
  if (next === prev) {
    console.log(`unchanged ${path}`);
    return;
  }
  writeFileSync(path, next);
  console.log(`patched ${path}`);
};

const stripStaleImportLines = (content) => content
  .replace(/^import \{ createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext \} from ['"]\.\.\/\.\.\/models\/providers\/deepseek-reasoning-fetch\.js['"];\r?\n/mg, '')
  .replace(/^import \{ createDeepSeekPayloadEventSink \} from ['"]\.\.\/budget\/budget\.js['"];\r?\n/mg, '')
  .replace(
    /^import \{ createAcontextTokenEventDraft, createDeepSeekPayloadEventSink \} from ['"]\.\.\/budget\/budget\.js['"];$/m,
    "import { createAcontextTokenEventDraft } from '../budget/budget.js';",
  );

const stripSimpleLines = (content) => content
  .replace(/^\s*const payloadEventSink = createDeepSeekPayloadEventSink\(events, options\);\r?\n/mg, '')
  .replace(/^\s*payloadEventSink\.attachRuntimeEventFactory\(createRuntimeEvent\);\r?\n/mg, '')
  .replace(/^\s*evictDeepSeekReasoningByPrefix\(createDeepSeekReasoningRunPrefix\(sessionId, requestedRunId\)\);\r?\n/mg, '')
  .replace(/\r?\n\s*evictDeepSeekReasoningByPrefix\(\r?\n\s*createDeepSeekReasoningRunPrefix\(sessionId, decodedRequest\.runId\),\r?\n\s*\);/g, '');

const unwrapReasoningContext = (content) => {
  let next = content;
  next = next.replace(
    /return await runWithDeepSeekReasoningContext\(\{\s*sessionId,\s*runId: requestedRunId,\s*onRequestPayload: payloadEventSink\.onRequestPayload,\s*\}, async \(\) => \{/s,
    'return await (async () => {',
  );
  next = next.replace(
    /return await runWithDeepSeekReasoningContext\(\{\s*sessionId,\s*runId: decodedRequest\.runId,\s*onRequestPayload: payloadEventSink\.onRequestPayload,\s*\}, async \(\) => \{/s,
    'return await (async () => {',
  );
  if (next.includes('return await (async () => {')) {
    next = next.replace(/\n\s*\}\);\n\s*\} catch \(error\) \{/s, '\n            })();\n        } catch (error) {');
  }
  return next;
};

for (const path of files) {
  const original = read(path);
  let next = original;

  if (!staleNames.some((name) => next.includes(name))) {
    console.log(`already repaired ${path}`);
    continue;
  }

  next = stripStaleImportLines(next);
  next = stripSimpleLines(next);
  next = unwrapReasoningContext(next);

  const remaining = staleNames.filter((name) => next.includes(name));
  if (remaining.length > 0) {
    throw new Error(`${path}: stale DeepSeek shim references remain after repair: ${remaining.join(', ')}`);
  }

  writeIfChanged(path, next, original);
}

console.log('DeepSeek reasoning 旧 shim 残留检查/修复完成。现在请重新 build sidecar 并重启桌面端。');
