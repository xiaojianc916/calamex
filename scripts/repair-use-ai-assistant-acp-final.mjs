import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const assistantPath = path.resolve(root, 'src/composables/ai/useAiAssistant.ts');
const specPath = path.resolve(root, 'src/composables/ai/useAiAssistant.spec.ts');
const tauriTypesPath = path.resolve(root, 'src/types/tauri/index.ts');

const read = (file) => fs.readFileSync(file, 'utf8');
const write = (file, content) => fs.writeFileSync(file, content);

const replaceRequired = (content, search, replacement, label) => {
  if (!content.includes(search)) {
    throw new Error(`未找到片段：${label}`);
  }
  return content.replace(search, replacement);
};

const replaceSection = (content, startMarker, endMarker, updater, label) => {
  const start = content.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`未找到 section 起点：${label}`);
  }
  const end = content.indexOf(endMarker, start);
  if (end < 0) {
    throw new Error(`未找到 section 终点：${label}`);
  }
  const before = content.slice(0, start);
  const section = content.slice(start, end);
  const after = content.slice(end);
  return `${before}${updater(section)}${after}`;
};

const normalizeUseAiAssistant = () => {
  let content = read(assistantPath);

  // 1) Chat 模式需要 request-scoped AbortController；不能用 activeAbortController，
  // stopCurrentRequest 会把 activeAbortController 清空，导致 sendPromise/late frame 竞态。
  content = replaceSection(
    content,
    'const executeAiRequest = async (',
    '  // -----------------------------------------------------------------------\n  // sendMessage / planAgentTask',
    (section) => {
      let next = section;

      if (!next.includes('const requestAbortController = activeAbortController.value;')) {
        next = replaceRequired(
          next,
          '    activeAbortController.value = new AbortController();\n\n    let hasSettledStream = false;',
          '    activeAbortController.value = new AbortController();\n    const requestAbortController = activeAbortController.value;\n\n    let hasSettledStream = false;',
          'chat requestAbortController',
        );
      }

      next = next.replace(
        /const liveEventBuffer = createSidecarLiveEventBuffer\(\(events, freshEvents\) => \{\n\s*if \(requestAbortController\.signal\.aborted\) \{\n\s*return;\n\s*\}\n\s*appendVisibleRuntimeTimelineEvents\(extractVisibleAgentRuntimeEvents\(freshEvents\)\);/,
        'const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {\n      if (requestAbortController.signal.aborted) {\n        return;\n      }\n      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));',
      );

      if (!next.includes('const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {\n      if (requestAbortController.signal.aborted) {')) {
        next = replaceRequired(
          next,
          'const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {\n      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));',
          'const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {\n      if (requestAbortController.signal.aborted) {\n        return;\n      }\n      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));',
          'chat liveEventBuffer abort guard',
        );
      }

      next = next.replace(
        /const sidecarStream = await subscribeSidecarStreamWithPrebuffer\(\(event\) => \{\n\s*if \(requestAbortController\.signal\.aborted\) \{\n\s*return;\n\s*\}\n\s*liveEventBuffer\.push\(event\);\n\s*\}\);/,
        'const sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {\n      if (requestAbortController.signal.aborted) {\n        return;\n      }\n      liveEventBuffer.push(event);\n    });',
      );

      if (!next.includes('const sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {\n      if (requestAbortController.signal.aborted) {')) {
        next = replaceRequired(
          next,
          'const sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {\n      liveEventBuffer.push(event);\n    });',
          'const sidecarStream = await subscribeSidecarStreamWithPrebuffer((event) => {\n      if (requestAbortController.signal.aborted) {\n        return;\n      }\n      liveEventBuffer.push(event);\n    });',
          'chat sidecar prebuffer abort guard',
        );
      }

      next = next.replace(
        '      if (activeAbortController.value?.signal.aborted) {\n        disposeSidecarAnswerStream(assistantMessageId);\n      } else {',
        '      if (requestAbortController.signal.aborted) {\n        disposeSidecarAnswerStream(assistantMessageId);\n      } else {',
      );

      return next;
    },
    'executeAiRequest',
  );

  // 2) Agent 模式不能引用 chat-only 的 requestAbortController。
  // 之前脚本误把 guard 写进 executeSidecarAgentRequest，导致一串 Agent 用例 ReferenceError。
  content = replaceSection(
    content,
    'const executeSidecarAgentRequest = async (',
    '  const resolveSidecarToolConfirmation = async (',
    (section) => {
      let next = section;
      next = next.replace(
        /const liveEventBuffer = createSidecarLiveEventBuffer\(\(events, freshEvents\) => \{\n\s*if \(requestAbortController\.signal\.aborted\) \{\n\s*return;\n\s*\}\n\s*appendVisibleRuntimeTimelineEvents\(extractVisibleAgentRuntimeEvents\(freshEvents\)\);/,
        'const liveEventBuffer = createSidecarLiveEventBuffer((events, freshEvents) => {\n      appendVisibleRuntimeTimelineEvents(extractVisibleAgentRuntimeEvents(freshEvents));',
      );
      next = next.replace(
        `    } catch (error) {
      if (requestAbortController.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {`,
        `    } catch (error) {
      if (activeAbortController.value?.signal.aborted) {
        disposeSidecarAnswerStream(assistantMessageId);
      } else {
        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));
      }
    } finally {`,
      );

      if (next.includes('requestAbortController')) {
        throw new Error('executeSidecarAgentRequest 仍残留 requestAbortController');
      }
      return next;
    },
    'executeSidecarAgentRequest',
  );

  // 3) stop chat 时保留已经流出的内容；Agent stop 才显示 Agent 文案。
  const oldStopBlock = `    if (activeAgentMessageId.value) {
      updateAgentExecutionMessage({
        messageId: activeAgentMessageId.value,
        content: 'Agent 执行已取消。',
        toolCalls: [],
        streamStatus: 'cancelled',
      });
      activeAgentMessageId.value = null;
    }`;
  const newStopBlock = `    if (activeAgentMessageId.value) {
      const activeMessageId = activeAgentMessageId.value;
      const currentMessage = findMessageById(activeMessageId);
      const isChatStreamCancellation = Boolean(streamId);

      updateAgentExecutionMessage({
        messageId: activeMessageId,
        content: isChatStreamCancellation ? (currentMessage?.content ?? '') : 'Agent 执行已取消。',
        toolCalls: isChatStreamCancellation ? (currentMessage?.toolCalls ?? []) : [],
        streamStatus: 'cancelled',
      });
      activeAgentMessageId.value = null;
    }`;
  if (content.includes(oldStopBlock)) {
    content = content.replace(oldStopBlock, newStopBlock);
  }

  if (content.includes('executeSidecarAgentRequest') && /executeSidecarAgentRequest[\s\S]*requestAbortController/.test(
    content.slice(content.indexOf('const executeSidecarAgentRequest = async ('), content.indexOf('  const resolveSidecarToolConfirmation = async (')),
  )) {
    throw new Error('Agent section 仍残留 requestAbortController');
  }

  write(assistantPath, content);
};

const normalizeSpec = () => {
  let content = read(specPath);

  // 4) fake timers 会覆盖 beforeEach 的同步 RAF stub；标题重试用例里重新 stub。
  content = replaceSection(
    content,
    "it('会话标题首次失败后会自动重试'",
    "  it('starts a new conversation",
    (section) => {
      let next = section;
      if (!next.includes("vi.stubGlobal('requestAnimationFrame'")) {
        next = replaceRequired(
          next,
          '    vi.useFakeTimers();\n    const assistant = createAssistantHarness();',
          "    vi.useFakeTimers();\n    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {\n      callback(0);\n      return 1;\n    });\n    const assistant = createAssistantHarness();",
          'title retry requestAnimationFrame stub',
        );
      }
      return next;
    },
    'title retry spec',
  );

  // 5) 确保等待 chat 启动时不会把 user message 当成 assistant stream。
  if (content.includes('const waitForStartedStream = async (')) {
    content = content.replace(
      /const waitForStartedStream = async \([\s\S]*?\n\};\n\nconst createDocument =/,
      `const waitForStartedStream = async (\n  resolveMessageId: () => string | undefined,\n  expectedId?: string,\n  maxAttempts = 16,\n): Promise<void> => {\n  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {\n    const messageId = resolveMessageId();\n    if (\n      messageId &&\n      (!expectedId || messageId === expectedId) &&\n      aiServiceMock.chatStream.mock.calls.length > 0\n    ) {\n      await flushMicrotasks();\n      return;\n    }\n    await flushMicrotasks();\n  }\n  throw new Error(\n    \`assistant stream did not start in time (expected id=\"\${expectedId ?? '<any>'}\" within \${maxAttempts} ticks)\`,\n  );\n};\n\nconst createDocument =`,
    );
  }

  write(specPath, content);
};

const normalizeTauriTypes = () => {
  if (!fs.existsSync(tauriTypesPath)) {
    return;
  }

  let content = read(tauriTypesPath);
  content = content.replace(
    /agentSidecarRestoreCheckpoint\(\n\s*payload: IAgentSidecarCheckpointRestoreRequest\): Promise<IAgentSidecarResponsePayload>;/,
    'agentSidecarRestoreCheckpoint(\n    payload: IAgentSidecarCheckpointRestoreRequest,\n  ): Promise<IAgentSidecarResponsePayload>;',
  );
  write(tauriTypesPath, content);
};

normalizeUseAiAssistant();
normalizeSpec();
normalizeTauriTypes();

console.log('已用新脚本完成最终修复：chat 取消只屏蔽 chat late frame，Agent sidecar 路径不再引用 requestAbortController，并修复标题重试 RAF/tauri 类型格式。');
