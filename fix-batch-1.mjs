#!/usr/bin/env node
/**
 * Slice 4 — user_message references 透传(动 schema,零回归):
 *  持久化模型补 references 字段,reduce / legacy-adapter 写入,
 *  thread-entries-to-timeline 透传(原硬编码 [])。
 *  build-thread-entries(渲染 VM 路径)早已透传 message.references,无需改。
 *
 * 改动文件:
 *  1) types/ai/thread/entry.schema.ts        — user_message schema 加 references(default [])
 *  2) store/aiThread/events.ts               — user_message reduce 事件加可选 references
 *  3) store/aiThread/reduce.ts               — 构造 user_message entry 时写 references
 *  4) projection/thread-entries-to-timeline.ts — references 由 entry 透传
 *  5) store/aiThread/legacy-adapter.ts       — user 消息透传 references
 *  6) store/aiThread/reduce.spec.ts          — +用例 & 类型导入
 *  7) store/aiThread/legacy-adapter.spec.ts  — +用例 & 类型导入
 *  8) projection/thread-entries-to-timeline.spec.ts — 重写首例为透传 + 补字面量 references
 *  9) types/ai/thread/entry.schema.spec.ts   — +schema 用例 & 导入
 *
 * 幂等:每文件有 marker,已应用则跳过。每处 find/replace 断言命中==1。
 * 逐文件探测 EOL(LF/CRLF),按原 EOL 写回。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = process.cwd();
const log = (m) => process.stdout.write(`${m}\n`);

const detectEol = (s) => (/\r\n/.test(s) ? '\r\n' : '\n');
const toEol = (s, eol) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);

const readRel = (rel) => {
  const p = resolve(ROOT, rel);
  if (!existsSync(p)) throw new Error(`MISSING_FILE: ${rel}`);
  return readFileSync(p, 'utf8');
};
const writeRel = (rel, content) => {
  const p = resolve(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
};

const applyEdits = (rel, marker, edits) => {
  let src = readRel(rel);
  const eol = detectEol(src);
  if (src.includes(toEol(marker, eol))) {
    log(`SKIP (already applied): ${rel}`);
    return;
  }
  for (const [label, find, replace] of edits) {
    const f = toEol(find, eol);
    const r = toEol(replace, eol);
    const hits = src.split(f).length - 1;
    if (hits !== 1) throw new Error(`EXPECT_1_GOT_${hits} :: ${rel} :: ${label}`);
    src = src.split(f).join(r);
  }
  writeRel(rel, src);
  log(`PATCHED (${eol === '\r\n' ? 'CRLF' : 'LF'}): ${rel}`);
};

/* 用双引号行数组拼接,内容无双引号字符,安全。 */
const J = (lines) => lines.join('\n');

/* ===== 1) entry.schema.ts ================================================= */
const ENTRY_SCHEMA = 'src/types/ai/thread/entry.schema.ts';
applyEdits(ENTRY_SCHEMA, 'references: z.array(aiContextReferenceSchema)', [
  [
    'import aiContextReferenceSchema',
    J([
      "import { aiTaskPlanStepSchema } from '@/types/ai/agent.schema';",
      "import {",
      "  aiConversationScrollStateSchema,",
      "  aiConversationTitleStatusSchema,",
      "} from '@/types/ai/conversation.schema';",
    ]),
    J([
      "import { aiTaskPlanStepSchema } from '@/types/ai/agent.schema';",
      "import { aiContextReferenceSchema } from '@/types/ai/context.schema';",
      "import {",
      "  aiConversationScrollStateSchema,",
      "  aiConversationTitleStatusSchema,",
      "} from '@/types/ai/conversation.schema';",
    ]),
  ],
  [
    'user_message schema +references',
    J([
      "export const aiThreadUserMessageEntrySchema = z.object({",
      "  type: z.literal('user_message'),",
      "  id: z.string().min(1),",
      "  createdAt: z.string().min(1),",
      "  content: z.array(aiThreadContentBlockSchema),",
      "});",
    ]),
    J([
      "export const aiThreadUserMessageEntrySchema = z.object({",
      "  type: z.literal('user_message'),",
      "  id: z.string().min(1),",
      "  createdAt: z.string().min(1),",
      "  content: z.array(aiThreadContentBlockSchema),",
      "  references: z.array(aiContextReferenceSchema).default([]),",
      "});",
    ]),
  ],
]);

/* ===== 2) events.ts ====================================================== */
const EVENTS = 'src/store/aiThread/events.ts';
applyEdits(EVENTS, 'references?: IAiContextReference[];', [
  [
    'import IAiContextReference',
    J([
      "import type {",
      "  IAiThreadChangedFilesEntry,",
    ]),
    J([
      "import type { IAiContextReference } from '@/types/ai/context';",
      "import type {",
      "  IAiThreadChangedFilesEntry,",
    ]),
  ],
  [
    'user_message event +references',
    J([
      "  | {",
      "      kind: 'user_message';",
      "      id: string;",
      "      createdAt: string;",
      "      blocks: IAiThreadContentBlock[];",
      "    }",
    ]),
    J([
      "  | {",
      "      kind: 'user_message';",
      "      id: string;",
      "      createdAt: string;",
      "      blocks: IAiThreadContentBlock[];",
      "      references?: IAiContextReference[];",
      "    }",
    ]),
  ],
]);

/* ===== 3) reduce.ts ===================================================== */
const REDUCE = 'src/store/aiThread/reduce.ts';
applyEdits(REDUCE, 'references: event.references ?? []', [
  [
    'reduce user_message +references',
    J([
      "    case 'user_message': {",
      "      const entry: IAiThreadEntry = {",
      "        type: 'user_message',",
      "        id: event.id,",
      "        createdAt: event.createdAt,",
      "        content: event.blocks,",
      "      };",
    ]),
    J([
      "    case 'user_message': {",
      "      const entry: IAiThreadEntry = {",
      "        type: 'user_message',",
      "        id: event.id,",
      "        createdAt: event.createdAt,",
      "        content: event.blocks,",
      "        references: event.references ?? [],",
      "      };",
    ]),
  ],
]);

/* ===== 4) thread-entries-to-timeline.ts ================================= */
const T2T = 'src/components/business/ai/thread/projection/thread-entries-to-timeline.ts';
applyEdits(T2T, 'references: entry.references,', [
  [
    'doc note',
    ' * - user-message 的 references 暂为空数组(数据模型尚未携带引用,留后续切片搬运)。',
    ' * - user-message 的 references 由数据模型透传(reduce / legacy-adapter 已携带)。',
  ],
  [
    'passthrough references',
    J([
      '          markdown: blocksToMarkdown(entry.content),',
      '          references: [],',
    ]),
    J([
      '          markdown: blocksToMarkdown(entry.content),',
      '          references: entry.references,',
    ]),
  ],
]);

/* ===== 5) legacy-adapter.ts ============================================= */
const LA = 'src/store/aiThread/legacy-adapter.ts';
applyEdits(LA, 'references: message.references,', [
  [
    'doc note',
    J([
      ' * - 附件 / references 映射为富块的工作留到后续细化（双轨期旧 store 仍保留',
      ' *   references 原数据，不会丢失）。',
    ]),
    ' * - 旧消息的 references 原样透传到 user_message entry；附件映射为富块留待后续细化。',
  ],
  [
    'user branch +references',
    J([
      '    return [',
      '      {',
      "        type: 'user_message',",
      '        id: message.id,',
      '        createdAt: message.createdAt,',
      "        content: text.trim().length > 0 ? [{ type: 'text', text }] : [],",
      '      },',
      '    ];',
    ]),
    J([
      '    return [',
      '      {',
      "        type: 'user_message',",
      '        id: message.id,',
      '        createdAt: message.createdAt,',
      "        content: text.trim().length > 0 ? [{ type: 'text', text }] : [],",
      '        references: message.references,',
      '      },',
      '    ];',
    ]),
  ],
]);

/* ===== 6) reduce.spec.ts =============================================== */
const REDUCE_SPEC = 'src/store/aiThread/reduce.spec.ts';
applyEdits(REDUCE_SPEC, 'user_message 透传 references；缺省兜底空数组', [
  [
    'imports',
    J([
      "import { nextToolStatus, reduceThread, reduceThreadAll } from '@/store/aiThread/reduce';",
      "import type {",
      "  IAiThread,",
      "  IAiThreadAssistantMessageEntry,",
      "  IAiThreadChangedFilesEntry,",
      "  IAiThreadContextCompactionEntry,",
      "  IAiThreadPlanEntry,",
      "  IAiThreadToolCall,",
      "} from '@/types/ai/thread';",
    ]),
    J([
      "import { nextToolStatus, reduceThread, reduceThreadAll } from '@/store/aiThread/reduce';",
      "import type { IAiContextReference } from '@/types/ai/context';",
      "import type {",
      "  IAiThread,",
      "  IAiThreadAssistantMessageEntry,",
      "  IAiThreadChangedFilesEntry,",
      "  IAiThreadContextCompactionEntry,",
      "  IAiThreadPlanEntry,",
      "  IAiThreadToolCall,",
      "  IAiThreadUserMessageEntry,",
      "} from '@/types/ai/thread';",
    ]),
  ],
  [
    'add test',
    "  it('tool_call 按 id upsert，不重复 append', () => {",
    J([
      "  it('user_message 透传 references；缺省兜底空数组', () => {",
      "    const ref: IAiContextReference = {",
      "      id: 'r1',",
      "      kind: 'current-file',",
      "      label: 'foo.ts',",
      "      path: 'src/foo.ts',",
      "      range: null,",
      "      contentPreview: '',",
      "      redacted: false,",
      "    };",
      "    const withRefs = reduceThread(createThread(), {",
      "      kind: 'user_message',",
      "      id: 'u1',",
      "      createdAt: ISO,",
      "      blocks: [{ type: 'text', text: 'hi' }],",
      "      references: [ref],",
      "    });",
      "    expect((withRefs.entries[0] as IAiThreadUserMessageEntry).references).toEqual([ref]);",
      "",
      "    const withoutRefs = reduceThread(createThread(), {",
      "      kind: 'user_message',",
      "      id: 'u2',",
      "      createdAt: ISO,",
      "      blocks: [],",
      "    });",
      "    expect((withoutRefs.entries[0] as IAiThreadUserMessageEntry).references).toEqual([]);",
      "  });",
      "",
      "  it('tool_call 按 id upsert，不重复 append', () => {",
    ]),
  ],
]);

/* ===== 7) legacy-adapter.spec.ts ======================================= */
const LA_SPEC = 'src/store/aiThread/legacy-adapter.spec.ts';
applyEdits(LA_SPEC, 'user 消息透传 references 到 user_message entry', [
  [
    'import IAiContextReference',
    J([
      "import type { IAiAgentPatchSummary, IAiChatMessage } from '@/types/ai';",
      "import type {",
      "  IAiThreadAssistantMessageEntry,",
    ]),
    J([
      "import type { IAiAgentPatchSummary, IAiChatMessage } from '@/types/ai';",
      "import type { IAiContextReference } from '@/types/ai/context';",
      "import type {",
      "  IAiThreadAssistantMessageEntry,",
    ]),
  ],
  [
    'add test',
    "  it('空 user 消息 -> 空 content 数组', () => {",
    J([
      "  it('user 消息透传 references 到 user_message entry', () => {",
      "    const ref: IAiContextReference = {",
      "      id: 'r1',",
      "      kind: 'selection',",
      "      label: 'sel',",
      "      path: 'src/a.ts',",
      "      range: { startLine: 1, endLine: 2 },",
      "      contentPreview: 'x',",
      "      redacted: false,",
      "    };",
      "    const entries = legacyMessageToEntries(userMessage({ references: [ref] }));",
      "    expect((entries[0] as IAiThreadUserMessageEntry).references).toEqual([ref]);",
      "  });",
      "",
      "  it('空 user 消息 -> 空 content 数组', () => {",
    ]),
  ],
]);

/* ===== 8) thread-entries-to-timeline.spec.ts =========================== */
const T2T_SPEC = 'src/components/business/ai/thread/projection/thread-entries-to-timeline.spec.ts';
applyEdits(T2T_SPEC, '投影为 user-message, 透传 references', [
  [
    'import IAiContextReference',
    "import type { IAiThreadEntry } from '@/types/ai/thread';",
    J([
      "import type { IAiContextReference } from '@/types/ai/context';",
      "import type { IAiThreadEntry } from '@/types/ai/thread';",
    ]),
  ],
  [
    'rewrite first test',
    J([
      "  it('user_message 投影为 user-message, references 暂为空', () => {",
      "    const entries: IAiThreadEntry[] = [",
      "      {",
      "        type: 'user_message',",
      "        id: 'u1',",
      "        createdAt: ISO,",
      "        content: [",
      "          { type: 'text', text: 'first' },",
      "          { type: 'text', text: 'second' },",
      "        ],",
      "      },",
      "    ];",
      "    const timeline = threadEntriesToTimeline(entries);",
      "    expect(timeline).toHaveLength(1);",
      "    const entry = timeline[0];",
      "    expect(entry.kind).toBe('user-message');",
      "    if (entry.kind === 'user-message') {",
      "      expect(entry.id).toBe('u1');",
      "      expect(entry.messageId).toBe('u1');",
      "      expect(entry.references).toEqual([]);",
      "      expect(entry.markdown).toContain('first');",
      "      expect(entry.markdown).toContain('second');",
      "    }",
      "  });",
    ]),
    J([
      "  it('user_message 投影为 user-message, 透传 references', () => {",
      "    const reference: IAiContextReference = {",
      "      id: 'r1',",
      "      kind: 'current-file',",
      "      label: 'foo.ts',",
      "      path: 'src/foo.ts',",
      "      range: null,",
      "      contentPreview: '',",
      "      redacted: false,",
      "    };",
      "    const entries: IAiThreadEntry[] = [",
      "      {",
      "        type: 'user_message',",
      "        id: 'u1',",
      "        createdAt: ISO,",
      "        content: [",
      "          { type: 'text', text: 'first' },",
      "          { type: 'text', text: 'second' },",
      "        ],",
      "        references: [reference],",
      "      },",
      "    ];",
      "    const timeline = threadEntriesToTimeline(entries);",
      "    expect(timeline).toHaveLength(1);",
      "    const entry = timeline[0];",
      "    expect(entry.kind).toBe('user-message');",
      "    if (entry.kind === 'user-message') {",
      "      expect(entry.id).toBe('u1');",
      "      expect(entry.messageId).toBe('u1');",
      "      expect(entry.references).toEqual([reference]);",
      "      expect(entry.markdown).toContain('first');",
      "      expect(entry.markdown).toContain('second');",
      "    }",
      "  });",
    ]),
  ],
  [
    'mixed-entries literal +references',
    "      { type: 'user_message', id: 'u1', createdAt: ISO, content: [{ type: 'text', text: 'hi' }] },",
    J([
      "      {",
      "        type: 'user_message',",
      "        id: 'u1',",
      "        createdAt: ISO,",
      "        content: [{ type: 'text', text: 'hi' }],",
      "        references: [],",
      "      },",
    ]),
  ],
]);

/* ===== 9) entry.schema.spec.ts ========================================= */
const ENTRY_SCHEMA_SPEC = 'src/types/ai/thread/entry.schema.spec.ts';
applyEdits(ENTRY_SCHEMA_SPEC, 'references 缺省兜底为空数组', [
  [
    'import schema',
    J([
      "import {",
      "  aiThreadAssistantChunkSchema,",
      "  aiThreadEntrySchema,",
      "  aiThreadSchema,",
      "  aiThreadToolCallSchema,",
      "  aiThreadToolKindSchema,",
      "} from '@/types/ai/thread';",
    ]),
    J([
      "import {",
      "  aiThreadAssistantChunkSchema,",
      "  aiThreadEntrySchema,",
      "  aiThreadSchema,",
      "  aiThreadToolCallSchema,",
      "  aiThreadToolKindSchema,",
      "  aiThreadUserMessageEntrySchema,",
      "} from '@/types/ai/thread';",
    ]),
  ],
  [
    'add test',
    "  it('拒绝非法的工具调用状态', () => {",
    J([
      "  it('user_message references 缺省兜底为空数组，提供则解析透传', () => {",
      "    const withDefault = aiThreadUserMessageEntrySchema.parse({",
      "      type: 'user_message',",
      "      id: 'u1',",
      "      createdAt: ISO,",
      "      content: [],",
      "    });",
      "    expect(withDefault.references).toEqual([]);",
      "",
      "    const parsed = aiThreadUserMessageEntrySchema.parse({",
      "      type: 'user_message',",
      "      id: 'u2',",
      "      createdAt: ISO,",
      "      content: [],",
      "      references: [",
      "        {",
      "          id: 'r1',",
      "          kind: 'current-file',",
      "          label: 'foo.ts',",
      "          path: 'src/foo.ts',",
      "          range: null,",
      "          contentPreview: '',",
      "          redacted: false,",
      "        },",
      "      ],",
      "    });",
      "    expect(parsed.references).toHaveLength(1);",
      "    expect(parsed.references[0]).toMatchObject({ id: 'r1', kind: 'current-file' });",
      "  });",
      "",
      "  it('拒绝非法的工具调用状态', () => {",
    ]),
  ],
]);

log('DONE');