// unify-step3.mjs —— Step 3「全部统一」：删双缓冲流 + reduce/authoritative 单写者
// 默认 dry-run（只校验+打印计划）；加 --apply 才落盘（每文件旁写 .bak，删 .bak 即还原）
// 全有或全无：任一锚点不匹配/计数不符 → 整体中止，不写任何文件。
import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const F_USE = 'src/composables/ai/useAiAssistant.ts';
const F_STREAM = 'src/composables/ai/useAiAssistant.stream.ts';
const F_SPEC = 'src/composables/ai/useAiAssistant.stream.spec.ts';

const log = [];
let failed = false;
const fail = (m) => { failed = true; log.push('  ❌ ' + m); };
const ok = (m) => log.push('  ✓ ' + m);

/* ============================ 词法工具 ============================ */
const skipStr = (s, i, q) => { i++; while (i < s.length) { const c = s[i]; if (c === '\\') { i += 2; continue; } if (c === q) return i + 1; i++; } return i; };
const skipTpl = (s, i) => {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && s[i + 1] === '{') {
      i += 2; let d = 1;
      while (i < s.length && d > 0) {
        const cc = s[i];
        if (cc === '{') { d++; i++; }
        else if (cc === '}') { d--; i++; }
        else if (cc === '`') i = skipTpl(s, i);
        else if (cc === '"' || cc === "'") i = skipStr(s, i, cc);
        else i++;
      }
      continue;
    }
    i++;
  }
  return i;
};
// 从 from 起，找到「深度 0 的语句终止 ;」之后的下标。单行/表达式体/花括号体通吃。
const stmtEnd = (s, from) => {
  let i = from, depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { const n = s.indexOf('\n', i); i = n < 0 ? s.length : n; continue; }
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; continue; }
    if (c === '"' || c === "'") { i = skipStr(s, i, c); continue; }
    if (c === '`') { i = skipTpl(s, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; i++; continue; }
    if (c === ';' && depth === 0) return i + 1;
    i++;
  }
  return s.length;
};
// 定位 `const|let <name> ...;` 整条语句区间（含起始缩进、含结尾 ;）
const regionByName = (s, name) => {
  const re = new RegExp(`(?:^|\\n)([ \\t]*)(?:const|let)\\s+${name}\\b`);
  const m = re.exec(s);
  if (!m) return null;
  const start = m.index + (s[m.index] === '\n' ? 1 : 0);
  return { start, end: stmtEnd(s, m.index + m[0].length) };
};

/* ============================ 编辑原语 ============================ */
const replaceDef = (s, name, text) => {
  const r = regionByName(s, name);
  if (!r) { fail(`定义未找到（重写）：${name}`); return s; }
  ok(`重写定义 ${name}`);
  const after = s[r.end] === '\n' ? r.end + 1 : r.end;
  return s.slice(0, r.start) + text + '\n' + s.slice(after);
};
const cutDef = (s, name) => {
  const r = regionByName(s, name);
  if (!r) { fail(`待删定义未找到：${name}`); return s; }
  ok(`删除定义 ${name}`);
  const after = s[r.end] === '\n' ? r.end + 1 : r.end;
  return s.slice(0, r.start) + s.slice(after);
};
// 正则替换 + 计数断言（re 必须带 g）
const rx = (s, label, re, rep, expect) => {
  const n = (s.match(re) || []).length;
  if (n !== expect) { fail(`${label}：期望 ${expect} 处，实际 ${n} 处`); return s; }
  ok(`${label}（${n} 处）`);
  return s.replace(re, rep);
};
// 字面替换 + 计数断言
const lit = (s, label, find, rep, expect) => {
  const n = s.split(find).length - 1;
  if (n !== expect) { fail(`${label}：期望 ${expect} 处，实际 ${n} 处`); return s; }
  ok(`${label}（${n} 处）`);
  return s.split(find).join(rep);
};

/* ====================== 新函数体（authoritative 单写者） ====================== */
const NEW_UPDATE_LIVE = `  interface ISidecarLiveRenderState {
    stream: NonNullable<IAiChatMessage['stream']>;
    patches: IAiChatMessage['patches'];
  }

  const updateLiveThreadFromSidecarEvents = (
    assistantMessageId: string,
    threadId: string | null,
    events: readonly TAgentUiEvent[],
    liveRenderState: ISidecarLiveRenderState,
  ): void => {
    const activeThread = conversationStore.activeConversationThread;
    const activeThreadId = unref(conversationStore.activeThreadId);
    // 仅当该回合线程正是当前可见线程时才覆盖投影，避免串台到其它会话。
    if (!activeThread || (threadId !== null && threadId !== activeThreadId)) {
      return;
    }
    const seedThread = legacyThreadToThread({
      ...activeThread,
      messages: activeThread.messages.filter((message) => message.id !== assistantMessageId),
    });
    const liveThread = buildLiveThreadFromSidecarEvents(events, {
      baseThread: seedThread,
      assistantMessageId,
      now: new Date().toISOString(),
    });
    // reduce 回放出的 assistant entry 不带 stream（runtimeEvents/token/活动文案）。
    // 用本回合实时算出的 stream/patches 富集该 entry——不再回读 legacy displayMessages（已退役）。
    const hasPatches = Boolean(liveRenderState.patches && liveRenderState.patches.length > 0);
    const enrichedThread = {
      ...liveThread,
      entries: liveThread.entries.map((entry) =>
        entry.type === 'assistant_message' && entry.id === assistantMessageId
          ? {
              ...entry,
              stream: liveRenderState.stream,
              ...(hasPatches ? { patches: [...(liveRenderState.patches ?? [])] } : {}),
            }
          : entry,
      ),
    };
    aiThreadStore.overlayStreamingActiveThread(enrichedThread);
  };`;

const NEW_APPLY = `  const applySidecarLiveEventsToAgentMessage = (
    assistantMessageId: string,
    threadId: string | null,
    fallbackContent: string,
    events: readonly TAgentUiEvent[],
  ): ISidecarLiveRenderState => {
    applyAcpReceiveSideEvents(events);
    // 仅做副作用 + 算出本帧 stream/patches；不再写 legacy displayMessages（reduce 为唯一写者）。
    void assistantMessageId;
    void threadId;
    const { errorEvent, doneEvent } = getLatestSidecarLiveEvents(events);
    const streamStatus: NonNullable<IAiChatMessage['stream']>['status'] =
      errorEvent || doneEvent ? 'completed' : 'streaming';
    const toolProjection = projectSidecarEventsToToolState({
      events,
      fallbackActivityText: fallbackContent,
      streamStatus,
    });
    const runtimeEvents = compactRuntimeEvents(extractVisibleAgentRuntimeEvents(events));
    const livePatchState = buildLiveAppliedPatchState(extractSidecarPatchEntries(events));

    for (const toolCall of toolProjection.toolCalls) {
      updateAgentStep(
        toolCall.id,
        toolCall.summary,
        mapSidecarToolCallStatusToStepStatus(toolCall.status),
      );
    }

    const tokenSnapshot = resolveSidecarDoneStreamTokenSnapshot(doneEvent);
    const stream: NonNullable<IAiChatMessage['stream']> = {
      status: streamStatus,
      ...(toolProjection.activityText !== undefined
        ? { activityText: toolProjection.activityText }
        : {}),
      ...(runtimeEvents.length ? { runtimeEvents } : {}),
      ...(tokenSnapshot ? { usage: tokenSnapshot } : {}),
    };

    return { stream, patches: livePatchState?.patches };
  };`;

const NEW_FINALIZE = `  const finalizeSidecarTurn = async (
    payload: Awaited<ReturnType<typeof aiService.sidecarChat>>,
    ctx: IFinalizeSidecarTurnContext,
  ): Promise<void> => {
    appendRuntimeTimelineEvents(payload.events);
    const projection = projectSidecarExecuteResponse(payload);
    const toolProjection = projectSidecarEventsToToolState({
      events: payload.events,
      fallbackActivityText: ctx.fallbackActivityText,
      streamStatus: resolveSidecarToolProjectionStatus(projection),
    });
    const sidecarStreamStatus = resolveSidecarWaitingStreamStatus(projection);
    const streamMetadata: ISidecarAnswerStreamMetadata = {
      messageId: ctx.assistantMessageId,
      threadId: ctx.threadId,
      toolCalls: toolProjection.toolCalls,
      streamStatus: sidecarStreamStatus,
      activityText: toolProjection.activityText,
      runtimeEvents: compactRuntimeEvents(extractVisibleAgentRuntimeEvents(payload.events)),
      streamTokenSnapshot: resolveSidecarDoneStreamTokenSnapshot(
        getLatestSidecarLiveEvents(payload.events).doneEvent,
      ),
    };

    const sidecarPatchEntries = projection.errorMessage
      ? []
      : extractSidecarPatchEntries(payload.events);
    const sidecarPatchResult =
      sidecarPatchEntries.length > 0
        ? await applySidecarPatchSets(sidecarPatchEntries, ctx.patchTaskId, ctx.patchSessionId)
        : { appliedPaths: [], runtimeEvents: [], patches: [], summaries: [] };
    const sidecarAppliedPaths = sidecarPatchResult.appliedPaths;
    const aedDiffPatchState = projection.errorMessage
      ? null
      : await loadAedDiffPatchStateForChangedFiles({
          changedFilePaths: projection.changedFilePaths,
          excludedPaths: sidecarAppliedPaths,
          fallbackTaskId: ctx.patchTaskId,
          runId: \`sidecar:\${ctx.patchTaskId}\`,
          stepId: 'agent',
        });
    const patchSummaries = [
      ...sidecarPatchResult.summaries,
      ...(aedDiffPatchState?.changedFilesSummary ? [aedDiffPatchState.changedFilesSummary] : []),
    ];
    const displayedPatches = [...sidecarPatchResult.patches, ...(aedDiffPatchState?.patches ?? [])];
    const changedFilesSummary = mergeAiAgentPatchSummaries(patchSummaries);
    const patchState =
      displayedPatches.length > 0 || changedFilesSummary
        ? { patches: displayedPatches, changedFilesSummary }
        : undefined;

    if (sidecarPatchResult.runtimeEvents.length > 0) {
      streamMetadata.runtimeEvents = compactRuntimeEvents([
        ...(streamMetadata.runtimeEvents ?? []),
        ...sidecarPatchResult.runtimeEvents,
      ]);
      appendVisibleRuntimeTimelineEvents(sidecarPatchResult.runtimeEvents);
    }

    if (ctx.updateSteps) {
      for (const toolCall of toolProjection.toolCalls) {
        updateAgentStep(
          toolCall.id,
          toolCall.summary,
          mapSidecarToolCallStatusToStepStatus(toolCall.status),
        );
      }
    }

    // 收尾：把本回合最终 reduce 态 + patches 写入 authoritative（mirror $subscribe 负责持久化）。
    const finalStream: NonNullable<IAiChatMessage['stream']> = {
      status: projection.errorMessage ? 'completed' : streamMetadata.streamStatus,
      ...(streamMetadata.activityText !== undefined
        ? { activityText: streamMetadata.activityText }
        : {}),
      ...(streamMetadata.runtimeEvents?.length
        ? { runtimeEvents: streamMetadata.runtimeEvents }
        : {}),
      ...(streamMetadata.streamTokenSnapshot
        ? { usage: streamMetadata.streamTokenSnapshot }
        : {}),
    };
    updateLiveThreadFromSidecarEvents(ctx.assistantMessageId, ctx.threadId, payload.events, {
      stream: finalStream,
      patches: patchState?.patches,
    });

    await refreshChangedDocumentsAfterSidecarRun(
      [...projection.changedFilePaths, ...sidecarAppliedPaths],
      projection.hasFileMutations || sidecarAppliedPaths.length > 0,
    );
    await updateFileRollbackPrompt(
      [...projection.changedFilePaths, ...sidecarAppliedPaths],
      projection.hasFileMutations || sidecarAppliedPaths.length > 0,
    );

    if (projection.pendingConfirmation) {
      ctx.onPendingConfirmation(projection.pendingConfirmation);
      return;
    }

    const pendingUserQuestion = extractPendingAskUser(payload);

    if (pendingUserQuestion) {
      ctx.onPendingUserQuestion(pendingUserQuestion);
      return;
    }

    clearSidecarToolConfirmation();
    clearSidecarUserQuestion();

    if (!projection.errorMessage) {
      clearAttachedFiles({ revokePreviews: false });
    }

    if (projection.errorMessage) {
      errorMessage.value = projection.errorMessage;
    }
  };`;

/* ====================== 14 个待删的双缓冲定义 ====================== */
const DEAD_DEFS = [
  'sidecarAnswerStream',
  'sidecarAnswerStreamState',
  'isSidecarAnswerStreamSyncSuppressed',
  'assignSidecarAnswerStreamMetadata',
  'resolveSidecarAnswerDisplayStatus',
  'syncSidecarAnswerStreamMessage',
  'runWithSuppressedSidecarAnswerSync',
  'ensureSidecarAnswerStreamState',
  'resetSidecarAnswerStreamContent',
  'updateSidecarAnswerStreamContent',
  'disposeSidecarAnswerStream',
  'hasActiveSidecarAnswerStreamSource',
  'completeSidecarAnswerStream',
  'waitForSidecarAnswerStreamCompletion',
];

/* ============================ 主流程 ============================ */
const read = (rel) => {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { fail(`文件不存在：${rel}`); return null; }
  return fs.readFileSync(p, 'utf8');
};

const edits = []; // { rel, next }

// ---------- 1) useAiAssistant.ts ----------
(() => {
  let s = read(F_USE);
  if (s == null) return;
  log.push(`【${F_USE}】`);

  // 1a. 三大函数体重写（reduce 单写者）
  s = replaceDef(s, 'updateLiveThreadFromSidecarEvents', NEW_UPDATE_LIVE);
  s = replaceDef(s, 'applySidecarLiveEventsToAgentMessage', NEW_APPLY);
  s = replaceDef(s, 'finalizeSidecarTurn', NEW_FINALIZE);

  // 1b. updateAgentExecutionMessage 去 finalAnswerStarted（函数保留，仍供 failSidecarAgentMessage 用）
  s = rx(s, '去 finalAnswerStarted?:boolean 字段',
    /\n[ \t]*finalAnswerStarted\?: boolean;/g, '', 1);
  s = rx(s, '去 finalAnswerStarted 解构',
    /(\n[ \t]*runtimeEvents,)\n[ \t]*finalAnswerStarted,(\n[ \t]*streamTokenSnapshot,)/g, '$1$2', 1);
  s = rx(s, '去 nextFinalAnswerStarted 计算',
    /\n[ \t]*const nextFinalAnswerStarted =\n[ \t]*finalAnswerStarted \?\?\n[ \t]*message\.stream\?\.finalAnswerStarted \?\?\n[ \t]*\(streamStatus === 'completed' && hasMeaningfulAssistantText\(content\)\);/g, '', 1);
  s = rx(s, '去 finalAnswerStarted 写回',
    /\n[ \t]*\.\.\.\(nextFinalAnswerStarted \? \{ finalAnswerStarted: true \} : \{\}\),/g, '', 1);

  // 1c. 删除「content/status 同步」watch（依赖已删的 sidecarAnswerStream）
  s = rx(s, '删除 sidecarAnswerStream 同步 watch',
    /\n[ \t]*watch\(\s*\(\) => \[sidecarAnswerStream\.content\.value, sidecarAnswerStream\.status\.value\] as const,\s*\(\) => \{\s*syncSidecarAnswerStreamMessage\(\);\s*\},\s*\{ flush: 'sync' \},\s*\);/g, '', 1);

  // 1d. catch 块：删 dispose、塌成 if(!aborted){ fail }
  s = rx(s, 'catch 收敛（active abort）',
    /if \(activeAbortController\.value\?\.signal\.aborted\) \{\s*disposeSidecarAnswerStream\(assistantMessageId\);\s*\} else \{\s*failSidecarAgentMessage\(assistantMessageId, toErrorMessage\(error, MSG_CALL_FAILED\)\);\s*\}/g,
    `if (!activeAbortController.value?.signal.aborted) {\n        failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));\n      }`, 1);
  s = rx(s, 'catch 收敛（request abort ×2）',
    /if \(requestAbortController\.signal\.aborted\) \{\s*disposeSidecarAnswerStream\(assistantMessageId\);\s*\} else \{\s*failSidecarAgentMessage\(assistantMessageId, toErrorMessage\(error, MSG_CALL_FAILED\)\);\s*\}/g,
    `if (!requestAbortController.signal.aborted) {\n          failSidecarAgentMessage(assistantMessageId, toErrorMessage(error, MSG_CALL_FAILED));\n        }`, 2);

  // 1e. 5 个 per-frame 回调：接住返回值 + 透传给 updateLiveThread
  s = rx(s, '回调接住 applySidecar 返回值（×5）',
    /(\n[ \t]*)applySidecarLiveEventsToAgentMessage\(/g, '$1const liveRenderState = applySidecarLiveEventsToAgentMessage(', 5);
  s = rx(s, 'updateLiveThread 透传 liveRenderState（×5）',
    /updateLiveThreadFromSidecarEvents\(([^;]*?), events\);/g, 'updateLiveThreadFromSidecarEvents($1, events, liveRenderState);', 5);

  // 1f. 删 14 个双缓冲定义（在删 watch/catch 之后，残留独立 dispose 调用恰为 3 个）
  for (const name of DEAD_DEFS) s = cutDef(s, name);

  // 1g. 删 3 个残留的独立 disposeSidecarAnswerStream(...) 语句（failSidecar / clearConversation / 卸载）
  s = rx(s, '删残留独立 dispose 调用（×3）',
    /^[ \t]*disposeSidecarAnswerStream\([^\n]*\);[ \t]*\n/gm, '', 3);

  // 1h. 收尾整理多余空行
  s = s.replace(/\n{3,}/g, '\n\n');

  edits.push({ rel: F_USE, next: s });

  // 残留扫描（应清零；ISidecarAnswerStreamState 若仍在 import → 交给 tsc 循环顺手删）
  const residual = [
    ...DEAD_DEFS,
    'finalMessageEvent',
  ].filter((n) => new RegExp(`\\b${n}\\b`).test(s));
  if (residual.length) log.push('  ⚠ 仍引用（多为 import，留给 vue-tsc 循环清理）：' + residual.join(', '));
  if (/\bISidecarAnswerStreamState\b/.test(s)) log.push('  ⚠ 仍引用 ISidecarAnswerStreamState（应仅剩 import 行，vue-tsc 会报未用 → 删之）');
})();

// ---------- 2) useAiAssistant.stream.ts ----------
(() => {
  let s = read(F_STREAM);
  if (s == null) return;
  log.push(`【${F_STREAM}】`);

  s = rx(s, '接口去 finalMessageEvent 字段',
    /\n[ \t]*finalMessageEvent: Extract<TAgentUiEvent, \{ type: 'message_delta' \}> \| null;/g, '', 1);
  s = rx(s, 'getLatest 初值去 finalMessageEvent',
    /\n[ \t]*finalMessageEvent: null,/g, '', 1);
  s = rx(s, 'getLatest 去 finalMessageEvent 赋值分支',
    /\n\n[ \t]*if \(!latest\.finalMessageEvent && event\.phase === 'final'\) \{\n[ \t]*latest\.finalMessageEvent = event;\n[ \t]*\}/g, '', 1);
  s = rx(s, 'getLatest break 条件去 finalMessageEvent',
    /if \(latest\.errorEvent && latest\.doneEvent && latest\.messageEvent && latest\.finalMessageEvent\) \{/g,
    'if (latest.errorEvent && latest.doneEvent && latest.messageEvent) {', 1);
  s = rx(s, 'Metadata 去 finalAnswerStarted 字段',
    /\n[ \t]*finalAnswerStarted: boolean \| undefined;/g, '', 1);
  s = rx(s, '删 ISidecarAnswerStreamState 接口',
    /\nexport interface ISidecarAnswerStreamState extends ISidecarAnswerStreamMetadata \{\n[ \t]*sourceText: string;\n\}\n/g, '\n', 1);

  s = s.replace(/\n{3,}/g, '\n\n');
  edits.push({ rel: F_STREAM, next: s });
})();

// ---------- 3) useAiAssistant.stream.spec.ts ----------
(() => {
  let s = read(F_SPEC);
  if (s == null) return;
  log.push(`【${F_SPEC}】`);

  s = lit(s, '去 getLatestSidecarLiveEvents import',
    `import {\n  createSidecarLiveEventBuffer,\n  getLatestSidecarLiveEvents,\n} from '@/composables/ai/useAiAssistant.stream';`,
    `import { createSidecarLiveEventBuffer } from '@/composables/ai/useAiAssistant.stream';`, 1);

  s = lit(s, '断言改写 #1（累计文本）',
    `    const { finalMessageEvent } = getLatestSidecarLiveEvents(buffer.events);\n\n    // 累计文本,而不是只保留最新片段(否则会出现“逐段替换”的回归)。\n    expect(finalMessageEvent?.text).toBe('日子缓缓向前，风掠过街巷与黄昏，不必追');\n    expect(finalMessageDeltas(buffer.events)).toHaveLength(1);`,
    `    const finalDeltas = finalMessageDeltas(buffer.events);\n\n    // 累计文本,而不是只保留最新片段(否则会出现“逐段替换”的回归)。\n    expect(finalDeltas[0]?.text).toBe('日子缓缓向前，风掠过街巷与黄昏，不必追');\n    expect(finalDeltas).toHaveLength(1);`, 1);

  s = lit(s, '断言改写 #2',
    `    const { finalMessageEvent } = getLatestSidecarLiveEvents(buffer.events);\n\n    expect(finalMessageEvent?.text).toBe('守好自己的节奏');\n    expect(finalMessageDeltas(buffer.events)).toHaveLength(1);`,
    `    const finalDeltas = finalMessageDeltas(buffer.events);\n\n    expect(finalDeltas[0]?.text).toBe('守好自己的节奏');\n    expect(finalDeltas).toHaveLength(1);`, 1);

  s = lit(s, '断言改写 #3',
    `    const { finalMessageEvent } = getLatestSidecarLiveEvents(buffer.events);\n    expect(finalMessageEvent?.text).toBe('答案A答案B');`,
    `    expect(finalMessageDeltas(buffer.events)[0]?.text).toBe('答案A答案B');`, 1);

  edits.push({ rel: F_SPEC, next: s });
})();

/* ============================ 输出 / 落盘 ============================ */
console.log('\n================ Step 3 统一脚本 ' + (APPLY ? '【APPLY】' : '【DRY-RUN】') + ' ================\n');
console.log(log.join('\n'));

if (failed) {
  console.log('\n🛑 存在未匹配的锚点，已中止——未写入任何文件。把以上输出贴回来，我据此修锚点。\n');
  process.exit(1);
}

if (!APPLY) {
  console.log('\n✅ 全部锚点匹配通过（dry-run）。确认无误后执行：node ' + path.basename(process.argv[1]) + ' --apply\n');
  process.exit(0);
}

for (const { rel, next } of edits) {
  const p = path.join(ROOT, rel);
  fs.writeFileSync(p + '.bak', fs.readFileSync(p)); // 备份原文件
  fs.writeFileSync(p, next, 'utf8');
  console.log('  ✍ 已写入 ' + rel + '（备份 ' + rel + '.bak）');
}
console.log('\n✅ Step 3 已落盘。还原：把每个 .bak 覆盖回原文件即可。\n');