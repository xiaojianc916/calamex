// scripts/apply-thread-timeline-flip.mjs
// Step 6（组件层）：AiThreadTimeline 增加 renderFromEntries 开关，true 时改用
// threadEntriesToTimeline 投影 reduce 模型条目；默认 false=旧路径，零行为变化、可回退。
// 纯 props 驱动，不引入 pinia 依赖（保持现有无-pinia 单测可跑）。
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const VUE = 'src/components/business/ai/thread/AiThreadTimeline.vue';
const SPEC = 'src/components/business/ai/thread/AiThreadTimeline.spec.ts';

function read(rel) {
  return readFileSync(`${ROOT}/${rel}`, 'utf8');
}
function detectNl(s) {
  return /\r\n/.test(s) ? '\r\n' : '\n';
}
// 用文件 EOL 拼接 find/replace 的行数组，单次替换并断言唯一命中。
function applyEdits(rel, edits) {
  let content = read(rel);
  const nl = detectNl(content);
  for (const { find, replace, label } of edits) {
    const from = find.join(nl);
    const to = replace.join(nl);
    const count = content.split(from).length - 1;
    if (count !== 1) {
      throw new Error(`✗ ${rel} 锚点命中 ${count} 次（应为 1）：${label}`);
    }
    content = content.replace(from, () => to);
  }
  writeFileSync(`${ROOT}/${rel}`, content);
  console.log(`✓ 已更新 ${rel}（${edits.length} 处）`);
}

/* ---------------- 1) AiThreadTimeline.vue ---------------- */
{
  const content = read(VUE);
  if (content.includes('renderFromEntries?: boolean')) {
    console.log(`• 跳过 ${VUE}（已包含 renderFromEntries，幂等）`);
  } else {
    applyEdits(VUE, [
      {
        label: 'import threadEntriesToTimeline',
        find: ["import { buildThreadEntries, type TAiThreadEntry } from './projection';"],
        replace: [
          "import { buildThreadEntries, threadEntriesToTimeline, type TAiThreadEntry } from './projection';",
        ],
      },
      {
        label: 'import IAiThreadEntry type',
        find: ["import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';"],
        replace: [
          "import type { IAiChatMessage, IAiPatchSet } from '@/types/ai';",
          "import type { IAiThreadEntry } from '@/types/ai/thread';",
        ],
      },
      {
        label: 'add props renderFromEntries/threadEntries',
        find: [
          '  revertingChangedFilesSummaryId?: string | null;',
          '  pinningChangedFilesSummaryId?: string | null;',
          '}>();',
        ],
        replace: [
          '  revertingChangedFilesSummaryId?: string | null;',
          '  pinningChangedFilesSummaryId?: string | null;',
          '  renderFromEntries?: boolean;',
          '  threadEntries?: readonly IAiThreadEntry[];',
          '}>();',
        ],
      },
      {
        label: 'switch entries source by renderFromEntries',
        find: [
          'const entries = computed<TAiThreadEntry[]>(() => buildThreadEntries(props.messages));',
        ],
        replace: [
          'const entries = computed<TAiThreadEntry[]>(() =>',
          '  props.renderFromEntries',
          '    ? threadEntriesToTimeline(props.threadEntries ?? [])',
          '    : buildThreadEntries(props.messages),',
          ');',
        ],
      },
    ]);
  }
}

/* ---------------- 2) AiThreadTimeline.spec.ts ---------------- */
{
  const content = read(SPEC);
  if (content.includes('threadEntriesToTimelineMock')) {
    console.log(`• 跳过 ${SPEC}（已包含 threadEntriesToTimelineMock，幂等）`);
  } else {
    applyEdits(SPEC, [
      {
        label: 'hoisted mocks',
        find: [
          'const { buildThreadEntriesMock } = vi.hoisted(() => ({ buildThreadEntriesMock: vi.fn() }));',
        ],
        replace: [
          'const { buildThreadEntriesMock, threadEntriesToTimelineMock } = vi.hoisted(() => ({',
          '  buildThreadEntriesMock: vi.fn(),',
          '  threadEntriesToTimelineMock: vi.fn(),',
          '}));',
        ],
      },
      {
        label: 'mock return adds threadEntriesToTimeline',
        find: ['  return { ...actual, buildThreadEntries: buildThreadEntriesMock };'],
        replace: [
          '  return {',
          '    ...actual,',
          '    buildThreadEntries: buildThreadEntriesMock,',
          '    threadEntriesToTimeline: threadEntriesToTimelineMock,',
          '  };',
        ],
      },
      {
        label: 'beforeEach resets threadEntriesToTimelineMock',
        find: [
          '  beforeEach(() => {',
          '    buildThreadEntriesMock.mockReset();',
          '    buildThreadEntriesMock.mockReturnValue(allEntries);',
          '  });',
        ],
        replace: [
          '  beforeEach(() => {',
          '    buildThreadEntriesMock.mockReset();',
          '    buildThreadEntriesMock.mockReturnValue(allEntries);',
          '    threadEntriesToTimelineMock.mockReset();',
          '    threadEntriesToTimelineMock.mockReturnValue(allEntries);',
          '  });',
        ],
      },
      {
        label: 'insert renderFromEntries test',
        find: ["  it('按条目类型分派渲染每一种条目组件', () => {"],
        replace: [
          "  it('renderFromEntries 为 true 时改用 threadEntriesToTimeline 投影 reduce 条目', () => {",
          '    const wrapper = mount(AiThreadTimeline, {',
          '      props: { messages: [], renderFromEntries: true, threadEntries: [] },',
          '      global: { stubs },',
          '    });',
          '',
          '    expect(threadEntriesToTimelineMock).toHaveBeenCalledTimes(1);',
          '    expect(buildThreadEntriesMock).not.toHaveBeenCalled();',
          '    expect(wrapper.findComponent(AiThreadUserMessage).exists()).toBe(true);',
          '  });',
          '',
          "  it('按条目类型分派渲染每一种条目组件', () => {",
        ],
      },
    ]);
  }
}

console.log('\n完成。请运行：pnpm lint && pnpm typecheck && pnpm test');