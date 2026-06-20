#!/usr/bin/env node
/**
 * Brick 2 — 前向通路（sidecar→reduce）工具标题 & 压缩文案 presenter 保真。
 *
 * 让 reduce/entries 成为渲染单一真源后，前向通路不再丢失 OLD(buildTimelineItems)
 * 已有的语义化工具标题与压缩文案：
 *   - tool.started / tool.completed 标题改用 describeToolAction(同一 presenter 真源)；
 *   - context_compaction 携带 describeRunEvent 文案；
 *   - reduce 事件 tool_completed 增可选 title，完成时刷新展示标题(缺省沿用 started)。
 *
 * 加性、可逆、向后兼容。终端快照/来源/awaiting/diff 内联为 KNOWN-GAP，留后续 sub-brick。
 *
 * 用法：
 *   node 1.mjs            # 应用
 *   node 1.mjs --check    # dry-run，仅校验匹配、不写盘
 *   REPO_ROOT=/path node 1.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT || process.cwd();
const DRY = process.argv.includes('--check');

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const write = (rel, content) => fs.writeFileSync(path.join(REPO_ROOT, rel), content, 'utf8');

const replaceOnce = (rel, content, find, replace) => {
  const n = content.split(find).length - 1;
  if (n !== 1) {
    throw new Error(
      `[${rel}] 期望恰好 1 处匹配，实际 ${n} 处。请核对源是否漂移：\n--- FIND ---\n${find}\n------------`,
    );
  }
  return content.replace(find, () => replace);
};

const tasks = [
  /* ---------- 1) 规范化器：presenter 标题 + 压缩文案 ---------- */
  {
    rel: 'src/components/business/ai/thread/projection/from-sidecar-events.ts',
    applied: (c) => c.includes('describeToolAction('),
    edits: [
      // 1a. 新增 presenter 导入（@/components 字母序在 @/constants 之前）
      [
        `import { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';`,
        `import { describeRunEvent, describeToolAction } from '@/components/business/ai/plan/runtime-timeline';\nimport { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';`,
      ],
      // 1b. tool.started 标题 → presenter
      [
        `          createdAt: event.timestamp,
          title: event.toolName,
          toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(event.toolName)],`,
        `          createdAt: event.timestamp,
          // 标题经 presenter 语义化（与 OLD buildTimelineItems 同源），消除前向通路「原始工具名」信息丢失。
          title: describeToolAction(event, event.toolName).action,
          toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(event.toolName)],`,
      ],
      // 1c. tool.completed 标题刷新（含/不含 appendContent 两路）
      [
        `    case 'agent.tool.completed': {
      const toolUseId = event.toolUseId ?? event.id;
      if (isCancelStatus(event.status)) {
        return [{ kind: 'tool_canceled', id: toolUseId }];
      }
      const appendContent = toToolOutputContent(
        event.ok ? event.resultPreview : (event.errorMessage ?? event.resultPreview),
      );
      if (appendContent === undefined) {
        return [{ kind: 'tool_completed', id: toolUseId, ok: event.ok }];
      }
      return [{ kind: 'tool_completed', id: toolUseId, ok: event.ok, appendContent }];
    }`,
        `    case 'agent.tool.completed': {
      const toolUseId = event.toolUseId ?? event.id;
      if (isCancelStatus(event.status)) {
        return [{ kind: 'tool_canceled', id: toolUseId }];
      }
      // 完成阶段标题经同源 presenter 语义化：完成后由「正在…」刷新为「已完成 / 失败」措辞。
      const title = describeToolAction(event, event.toolName).action;
      const appendContent = toToolOutputContent(
        event.ok ? event.resultPreview : (event.errorMessage ?? event.resultPreview),
      );
      if (appendContent === undefined) {
        return [{ kind: 'tool_completed', id: toolUseId, ok: event.ok, title }];
      }
      return [{ kind: 'tool_completed', id: toolUseId, ok: event.ok, title, appendContent }];
    }`,
      ],
      // 1d. context_compaction 文案 → presenter
      [
        `    case 'acontext.context_compaction.completed':
      return [{ kind: 'context_compaction', id: event.compactionId, createdAt: event.timestamp }];`,
        `    case 'acontext.context_compaction.completed': {
      // 压缩文案经 presenter（describeRunEvent）语义化，消除前向通路「兜底占位文案」信息丢失。
      const message = describeRunEvent(event) ?? undefined;
      return [
        {
          kind: 'context_compaction',
          id: event.compactionId,
          createdAt: event.timestamp,
          ...(message !== undefined ? { message } : {}),
        },
      ];
    }`,
      ],
    ],
  },

  /* ---------- 2) reduce 事件类型：tool_completed 增可选 title ---------- */
  {
    rel: 'src/store/aiThread/events.ts',
    applied: (c) => c.includes('完成阶段的展示标题'),
    edits: [
      [
        `  | {
      kind: 'tool_completed';
      id: string;
      ok: boolean;
      appendContent?: IAiThreadToolCallContent[];
    }`,
        `  | {
      kind: 'tool_completed';
      id: string;
      ok: boolean;
      /** 完成阶段的展示标题（presenter「已完成 / 失败」措辞）；缺省则沿用 tool_started 标题。 */
      title?: string;
      appendContent?: IAiThreadToolCallContent[];
    }`,
      ],
    ],
  },

  /* ---------- 3) reduce 写入：完成时刷新标题（缺省沿用） ---------- */
  {
    rel: 'src/store/aiThread/reduce.ts',
    applied: (c) => (c.match(/title: event\.title \|\| current\.title/g) || []).length >= 2,
    edits: [
      [
        `    case 'tool_completed':
      return {
        ...current,
        status: nextToolStatus(current.status, event.ok ? 'completed' : 'failed'),
        content: event.appendContent
          ? [...current.content, ...event.appendContent]
          : current.content,
      };`,
        `    case 'tool_completed':
      return {
        ...current,
        // 完成阶段刷新展示标题（presenter「已完成 / 失败」措辞）；缺省沿用 started 标题。
        title: event.title || current.title,
        status: nextToolStatus(current.status, event.ok ? 'completed' : 'failed'),
        content: event.appendContent
          ? [...current.content, ...event.appendContent]
          : current.content,
      };`,
      ],
    ],
  },

  /* ---------- 4) 规范化器 spec：断言委托 presenter（动态期望） ---------- */
  {
    rel: 'src/components/business/ai/thread/projection/from-sidecar-events.spec.ts',
    applied: (c) => c.includes('describeToolAction('),
    edits: [
      // 4a. 导入 presenter
      [
        `import { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';`,
        `import { describeRunEvent, describeToolAction } from '@/components/business/ai/plan/runtime-timeline';\nimport { classifyRuntimeToolKind } from '@/constants/ai/runtime-tools';`,
      ],
      // 4b. 工具开始
      [
        `  it('工具开始 → tool_started（kind 由工具名经单一映射表派生）', () => {
    const toolName = 'read_file';
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('e1'), type: 'agent.tool.started', toolUseId: 'tool-1', toolName }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_started',
        id: 'tool-1',
        createdAt: TS,
        title: toolName,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(toolName)],
        status: 'in_progress',
      },
    ]);
  });`,
        `  it('工具开始 → tool_started（标题经 presenter 派生、kind 由单一映射表派生）', () => {
    const toolName = 'read_file';
    const started = {
      ...makeBase('e1'),
      type: 'agent.tool.started' as const,
      toolUseId: 'tool-1',
      toolName,
    };
    expect(sidecarEventToReduceEvents(wrap(started), OPTIONS)).toEqual([
      {
        kind: 'tool_started',
        id: 'tool-1',
        createdAt: TS,
        title: describeToolAction(started, toolName).action,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(toolName)],
        status: 'in_progress',
      },
    ]);
  });`,
      ],
      // 4c. 缺 toolUseId
      [
        `  it('缺 toolUseId 时回退到事件 id', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({ ...makeBase('evt-x'), type: 'agent.tool.started', toolName: 'grep' }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_started',
        id: 'evt-x',
        createdAt: TS,
        title: 'grep',
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind('grep')],
        status: 'in_progress',
      },
    ]);
  });`,
        `  it('缺 toolUseId 时回退到事件 id', () => {
    const started = { ...makeBase('evt-x'), type: 'agent.tool.started' as const, toolName: 'grep' };
    expect(sidecarEventToReduceEvents(wrap(started), OPTIONS)).toEqual([
      {
        kind: 'tool_started',
        id: 'evt-x',
        createdAt: TS,
        title: describeToolAction(started, 'grep').action,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind('grep')],
        status: 'in_progress',
      },
    ]);
  });`,
      ],
      // 4d. 工具完成(ok)
      [
        `  it('工具完成(ok) → tool_completed', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: true,
        }),
        OPTIONS,
      ),
    ).toEqual([{ kind: 'tool_completed', id: 'tool-1', ok: true }]);
  });`,
        `  it('工具完成(ok) → tool_completed（标题刷新为 presenter 完成措辞）', () => {
    const completed = {
      ...makeBase('e1'),
      type: 'agent.tool.completed' as const,
      toolUseId: 'tool-1',
      toolName: 'read_file',
      ok: true,
    };
    expect(sidecarEventToReduceEvents(wrap(completed), OPTIONS)).toEqual([
      { kind: 'tool_completed', id: 'tool-1', ok: true, title: describeToolAction(completed, 'read_file').action },
    ]);
  });`,
      ],
      // 4e. 工具完成(ok, resultPreview)
      [
        `  it('工具完成(ok, 有 resultPreview) → tool_completed 附 Output 内容块', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: true,
          resultPreview: '读到 42 行',
        }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_completed',
        id: 'tool-1',
        ok: true,
        appendContent: [{ type: 'content', block: { type: 'text', text: '读到 42 行' } }],
      },
    ]);
  });`,
        `  it('工具完成(ok, 有 resultPreview) → tool_completed 附 Output 内容块', () => {
    const completed = {
      ...makeBase('e1'),
      type: 'agent.tool.completed' as const,
      toolUseId: 'tool-1',
      toolName: 'read_file',
      ok: true,
      resultPreview: '读到 42 行',
    };
    expect(sidecarEventToReduceEvents(wrap(completed), OPTIONS)).toEqual([
      {
        kind: 'tool_completed',
        id: 'tool-1',
        ok: true,
        title: describeToolAction(completed, 'read_file').action,
        appendContent: [{ type: 'content', block: { type: 'text', text: '读到 42 行' } }],
      },
    ]);
  });`,
      ],
      // 4f. 工具失败
      [
        `  it('工具失败 → tool_completed(ok:false) 附 errorMessage 内容块', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'agent.tool.completed',
          toolUseId: 'tool-1',
          toolName: 'read_file',
          ok: false,
          errorMessage: '文件不存在',
        }),
        OPTIONS,
      ),
    ).toEqual([
      {
        kind: 'tool_completed',
        id: 'tool-1',
        ok: false,
        appendContent: [{ type: 'content', block: { type: 'text', text: '文件不存在' } }],
      },
    ]);
  });`,
        `  it('工具失败 → tool_completed(ok:false) 附 errorMessage 内容块', () => {
    const completed = {
      ...makeBase('e1'),
      type: 'agent.tool.completed' as const,
      toolUseId: 'tool-1',
      toolName: 'read_file',
      ok: false,
      errorMessage: '文件不存在',
    };
    expect(sidecarEventToReduceEvents(wrap(completed), OPTIONS)).toEqual([
      {
        kind: 'tool_completed',
        id: 'tool-1',
        ok: false,
        title: describeToolAction(completed, 'read_file').action,
        appendContent: [{ type: 'content', block: { type: 'text', text: '文件不存在' } }],
      },
    ]);
  });`,
      ],
      // 4g. 上下文压缩
      [
        `  it('上下文压缩完成 → context_compaction', () => {
    expect(
      sidecarEventToReduceEvents(
        wrap({
          ...makeBase('e1'),
          type: 'acontext.context_compaction.completed',
          compactionId: 'cmp-1',
          reason: 'budget',
          summaryCharCount: 10,
        }),
        OPTIONS,
      ),
    ).toEqual([{ kind: 'context_compaction', id: 'cmp-1', createdAt: TS }]);
  });`,
        `  it('上下文压缩完成 → context_compaction（附 presenter 文案）', () => {
    const compaction = {
      ...makeBase('e1'),
      type: 'acontext.context_compaction.completed' as const,
      compactionId: 'cmp-1',
      reason: 'budget' as const,
      summaryCharCount: 10,
    };
    expect(sidecarEventToReduceEvents(wrap(compaction), OPTIONS)).toEqual([
      {
        kind: 'context_compaction',
        id: 'cmp-1',
        createdAt: TS,
        message: describeRunEvent(compaction) ?? undefined,
      },
    ]);
  });`,
      ],
    ],
  },

  /* ---------- 5) reduce spec：完成刷新 / 缺省沿用标题 ---------- */
  {
    rel: 'src/store/aiThread/reduce.spec.ts',
    applied: (c) => c.includes('刷新展示标题'),
    edits: [
      [
        `    thread = reduceThread(thread, { kind: 'tool_completed', id: 't1', ok: true });
    thread = reduceThread(thread, { kind: 'tool_progress', id: 't1' });
    expect((thread.entries[0] as IAiThreadToolCall).status).toBe('completed');
  });`,
        `    thread = reduceThread(thread, { kind: 'tool_completed', id: 't1', ok: true });
    thread = reduceThread(thread, { kind: 'tool_progress', id: 't1' });
    expect((thread.entries[0] as IAiThreadToolCall).status).toBe('completed');
  });

  it('tool_completed 携带 title 时刷新展示标题；缺省沿用 started 标题', () => {
    let withTitle = createThread();
    withTitle = reduceThread(withTitle, {
      kind: 'tool_started',
      id: 't1',
      createdAt: ISO,
      title: '正在查看 foo.ts',
      toolKind: 'read',
    });
    withTitle = reduceThread(withTitle, {
      kind: 'tool_completed',
      id: 't1',
      ok: true,
      title: '已查看 foo.ts',
    });
    expect((withTitle.entries[0] as IAiThreadToolCall).title).toBe('已查看 foo.ts');

    let keepTitle = createThread();
    keepTitle = reduceThread(keepTitle, {
      kind: 'tool_started',
      id: 't2',
      createdAt: ISO,
      title: '正在执行 build',
      toolKind: 'execute',
    });
    keepTitle = reduceThread(keepTitle, { kind: 'tool_completed', id: 't2', ok: true });
    expect((keepTitle.entries[0] as IAiThreadToolCall).title).toBe('正在执行 build');
  });`,
      ],
    ],
  },
];

let changed = 0;
let skipped = 0;
for (const task of tasks) {
  const abs = path.join(REPO_ROOT, task.rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`缺少文件（源可能漂移）: ${task.rel}`);
  }
  let content = read(task.rel);
  if (task.applied(content)) {
    console.log(`skip (已应用): ${task.rel}`);
    skipped += 1;
    continue;
  }
  for (const [find, replace] of task.edits) {
    content = replaceOnce(task.rel, content, find, replace);
  }
  if (DRY) {
    console.log(`[check] 将修改: ${task.rel}`);
  } else {
    write(task.rel, content);
    console.log(`updated: ${task.rel}`);
  }
  changed += 1;
}
console.log(`\n完成：${changed} 改，${skipped} 跳过${DRY ? '（dry-run，未写盘）' : ''}`);