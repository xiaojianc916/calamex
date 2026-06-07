import { readFileSync, writeFileSync } from 'node:fs';

const editsByFile = {
  'agent-sidecar/src/engines/context/memory.ts': [
    {
      marker: 'const nullableOptionalTrimmedStringSchema',
      find: `const optionalTrimmedStringSchema = trimmedNonEmptyStringSchema.optional();`,
      replace: `const optionalTrimmedStringSchema = trimmedNonEmptyStringSchema.optional();
// 放宽 lastStopReason 规则：允许字段省略、传 null、传空字符串。当模型无停止原因时，
// 无需强制填充内容，空值/省略/null 均为合法值，避免模型因校验规则被迫编造内容。
const nullableOptionalTrimmedStringSchema = z.string().trim().nullable().optional();`,
    },
    {
      marker: 'lastStopReason: nullableOptionalTrimmedStringSchema,',
      find: `            lastStopReason: optionalTrimmedStringSchema,`,
      replace: `            lastStopReason: nullableOptionalTrimmedStringSchema,`,
    },
  ],
  'src/composables/ai/sidecar-events.ts': [
    {
      marker: 'const SIDECAR_HIDDEN_TOOL_NAMES',
      find: `  'create_directory',
  'move_file',
  'delete_file',
]);`,
      replace: `  'create_directory',
  'move_file',
  'delete_file',
]);

// 内部运维类工具（如 Mastra 工作内存写入）禁止对外展示为工具调用或动态提示文本。
// 这类工具会传输 { memory: { currentTask: ... } } 格式原始数据，导致“正在思考”折叠栏上方
// 出现带「处理」前缀的杂乱内容。tool_start、tool_result 及运行时智能体事件三条链路均需拦截。
const SIDECAR_HIDDEN_TOOL_NAMES = new Set<string>([
  'updateWorkingMemory',
  'update_working_memory',
  '__updateWorkingMemory',
  '__update_working_memory__',
]);`,
    },
    {
      marker: `      if (SIDECAR_HIDDEN_TOOL_NAMES.has(event.toolName)) {
        continue;
      }
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
      const descriptor`,
      find: `    if (event.type === 'tool_start') {
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
      const descriptor = describeToolPayload(event.toolName, event.input);`,
      replace: `    if (event.type === 'tool_start') {
      if (SIDECAR_HIDDEN_TOOL_NAMES.has(event.toolName)) {
        continue;
      }
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
      const descriptor = describeToolPayload(event.toolName, event.input);`,
    },
    {
      marker: `      if (SIDECAR_HIDDEN_TOOL_NAMES.has(event.toolName)) {
        continue;
      }
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
      let existingIndex`,
      find: `    if (event.type === 'tool_result') {
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
      let existingIndex = -1;`,
      replace: `    if (event.type === 'tool_result') {
      if (SIDECAR_HIDDEN_TOOL_NAMES.has(event.toolName)) {
        continue;
      }
      if (runtimeToolNames.has(event.toolName)) {
        continue;
      }
      let existingIndex = -1;`,
    },
    {
      marker: 'SIDECAR_HIDDEN_TOOL_NAMES.has(event.event.toolName)',
      find: `    if (event.type === 'agent_event') {
      applyRuntimeToolEventToToolCalls(toolCalls, event.event);
    }`,
      replace: `    if (event.type === 'agent_event') {
      if (
        isAgentRuntimeToolEvent(event.event) &&
        SIDECAR_HIDDEN_TOOL_NAMES.has(event.event.toolName)
      ) {
        continue;
      }
      applyRuntimeToolEventToToolCalls(toolCalls, event.event);
    }`,
    },
  ],
  'src/composables/ai/sidecar-events.spec.ts': [
    {
      marker: '不在思考折叠上方露出',
      find: `    expect(projection.activityText).toBe('检查工作区');
    expect(projection.toolCalls).toEqual([]);
    expect(Object.hasOwn(projection, 'activities')).toBe(false);
  });
});`,
      replace: `    expect(projection.activityText).toBe('检查工作区');
    expect(projection.toolCalls).toEqual([]);
    expect(Object.hasOwn(projection, 'activities')).toBe(false);
  });

  it('隐藏 Mastra 工作内存写入工具,不在思考折叠上方露出「处理 {memory}」', () => {
    const events: TAgentUiEvent[] = [
      {
        type: 'tool_start',
        toolName: 'updateWorkingMemory',
        input: { memory: { currentTask: { goal: '解答气候变化', status: 'active' } } },
      },
      { type: 'tool_result', toolName: 'updateWorkingMemory', output: { success: true } },
    ];

    expect(mapSidecarEventsToToolCalls(events)).toEqual([]);

    const projection = projectSidecarEventsToToolState({
      fallbackActivityText: '正在思考',
      streamStatus: 'streaming',
      events,
    });
    expect(projection.toolCalls).toEqual([]);
    expect(projection.activityText).toBe('正在思考');
    expect(projection.activityText).not.toContain('memory');
    expect(projection.activityText).not.toContain('处理');
  });

  it('运行时 agent 事件里的工作内存写入同样被隐藏', () => {
    const events: TAgentUiEvent[] = [
      {
        type: 'agent_event',
        event: {
          id: 'mem-start', type: 'agent.tool.started', runId: 'run-1', sessionId: 'session-1',
          agentId: 'agent-1', timestamp: '2026-06-07T07:00:00.000Z', seq: 0, schemaVersion: 1,
          redacted: true, visibility: 'user', level: 'info', toolUseId: 'mem-1',
          toolName: 'updateWorkingMemory', inputPreview: '{"memory":{"currentTask":{"goal":"x"}}}',
        },
      },
      {
        type: 'agent_event',
        event: {
          id: 'mem-done', type: 'agent.tool.completed', runId: 'run-1', sessionId: 'session-1',
          agentId: 'agent-1', timestamp: '2026-06-07T07:00:01.000Z', seq: 1, schemaVersion: 1,
          redacted: true, visibility: 'user', level: 'info', toolUseId: 'mem-1',
          toolName: 'updateWorkingMemory', ok: true, resultPreview: '{"success":true}',
        },
      },
    ];

    expect(mapSidecarEventsToToolCalls(events)).toEqual([]);
  });
});`,
    },
  ],
};

const planned = [];
for (const [file, edits] of Object.entries(editsByFile)) {
  let content = readFileSync(file, 'utf8');
  for (const { marker, find, replace } of edits) {
    if (content.includes(marker)) { console.log(`✓ 已应用,跳过: ${file}`); continue; }
    const count = content.split(find).length - 1;
    if (count !== 1) throw new Error(`✗ ${file}: 锚点命中 ${count} 次(期望 1),已中止,未写入任何文件。`);
    content = content.replace(find, replace);
  }
  planned.push([file, content]);
}
for (const [file, content] of planned) { writeFileSync(file, content, 'utf8'); console.log(`✓ 写入: ${file}`); }
console.log('全部应用完成,请先类型检查 + 跑单测再提交。');