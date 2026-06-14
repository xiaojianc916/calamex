import { readFileSync, writeFileSync } from 'node:fs';

const replaceOnce = (content, from, to, path) => {
  const count = content.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${path}: expected exactly one match for ${JSON.stringify(from)}, got ${count}`);
  }
  return content.replace(from, to);
};

const replaceRegexOnce = (content, pattern, to, path, label) => {
  const matches = content.match(pattern);
  if (!matches) {
    throw new Error(`${path}: cannot locate ${label}`);
  }
  return content.replace(pattern, to);
};

const writeIfChanged = (path, content, original) => {
  if (content !== original) {
    writeFileSync(path, content);
    console.log(`patched ${path}`);
  } else {
    console.log(`unchanged ${path}`);
  }
};

const patchChat = () => {
  const path = 'agent-sidecar/src/engines/chat/chat.ts';
  let content = readFileSync(path, 'utf8');
  const original = content;

  content = content.replace(
    "import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../../models/providers/deepseek-reasoning-fetch.js';\n",
    '',
  );
  content = content.replace(
    "import { createAcontextTokenEventDraft, createDeepSeekPayloadEventSink } from '../budget/budget.js';",
    "import { createAcontextTokenEventDraft } from '../budget/budget.js';",
  );
  content = content.replace(
    "        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);\n",
    '',
  );
  content = replaceRegexOnce(
    content,
    /            return await runWithDeepSeekReasoningContext\(\{\n                sessionId,\n                runId: requestedRunId,\n                onRequestPayload: payloadEventSink\.onRequestPayload,\n            \}, async \(\) => \{/,
    '            return await (async () => {',
    path,
    'runWithDeepSeekReasoningContext wrapper',
  );
  content = replaceOnce(
    content,
    "                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);\n",
    '',
    path,
  );
  content = replaceRegexOnce(
    content,
    /\n            \}\);\n        \} catch \(error\) \{/,
    '\n            })();\n        } catch (error) {',
    path,
    'closing wrapper before catch',
  );
  content = content.replace(
    "                evictDeepSeekReasoningByPrefix(createDeepSeekReasoningRunPrefix(sessionId, requestedRunId));\n",
    '',
  );

  if (content.includes('deepseek-reasoning-fetch') || content.includes('createDeepSeekPayloadEventSink')) {
    throw new Error(`${path}: stale DeepSeek shim references remain`);
  }
  writeIfChanged(path, content, original);
};

const patchApproval = () => {
  const path = 'agent-sidecar/src/engines/approval-client/client.ts';
  let content = readFileSync(path, 'utf8');
  const original = content;

  content = content.replace(
    "import { createDeepSeekReasoningRunPrefix, evictDeepSeekReasoningByPrefix, runWithDeepSeekReasoningContext } from '../../models/providers/deepseek-reasoning-fetch.js';\n",
    '',
  );
  content = content.replace(
    "import { createDeepSeekPayloadEventSink } from '../budget/budget.js';\n",
    '',
  );
  content = content.replace(
    "        const payloadEventSink = createDeepSeekPayloadEventSink(events, options);\n",
    '',
  );
  content = replaceRegexOnce(
    content,
    /            return await runWithDeepSeekReasoningContext\(\{\n                sessionId,\n                runId: decodedRequest\.runId,\n                onRequestPayload: payloadEventSink\.onRequestPayload,\n            \}, async \(\) => \{/,
    '            return await (async () => {',
    path,
    'runWithDeepSeekReasoningContext wrapper',
  );
  content = replaceOnce(
    content,
    "                payloadEventSink.attachRuntimeEventFactory(createRuntimeEvent);\n",
    '',
    path,
  );
  content = replaceRegexOnce(
    content,
    /\n            \}\);\n        \} catch \(error\) \{/,
    '\n            })();\n        } catch (error) {',
    path,
    'closing wrapper before catch',
  );
  content = content.replace(
    /\n                evictDeepSeekReasoningByPrefix\(\n                    createDeepSeekReasoningRunPrefix\(sessionId, decodedRequest\.runId\),\n                \);/,
    '',
  );

  if (content.includes('deepseek-reasoning-fetch') || content.includes('createDeepSeekPayloadEventSink')) {
    throw new Error(`${path}: stale DeepSeek shim references remain`);
  }
  writeIfChanged(path, content, original);
};

patchChat();
patchApproval();

console.log('已移除 agent-sidecar 残留 DeepSeek reasoning shim 引用；请重新 build sidecar 并重启桌面端。');
