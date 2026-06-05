// fix-problems.mjs — 修复 VS Code 问题面板的 3 项（CRLF/LF 自适应 + 幂等）
import { readFileSync, writeFileSync } from 'node:fs';

let changed = 0;
let skipped = 0;

/**
 * 把锚点里的 \n 适配成目标文件实际使用的换行符；
 * 已应用则跳过；锚点缺失或重复则中止（不写坏文件）。
 */
function edit(file, oldLf, newLf, label) {
    const raw = readFileSync(file, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const oldStr = oldLf.split('\n').join(eol);
    const newStr = newLf.split('\n').join(eol);

    if (!raw.includes(oldStr) && raw.includes(newStr)) {
        console.log(`• 跳过(已应用)：${label}`);
        skipped++;
        return;
    }
    const count = raw.split(oldStr).length - 1;
    if (count === 0) throw new Error(`✗ 未找到锚点，已中止：${label}\n  文件：${file}`);
    if (count > 1) throw new Error(`✗ 锚点出现 ${count} 次，已中止：${label}\n  文件：${file}`);

    writeFileSync(file, raw.replace(oldStr, newStr), 'utf8');
    console.log(`✓ 已修复：${label}`);
    changed++;
}

const VUE = 'src/components/workbench/SshSidebarPanel.vue';
const SESSION = 'src/terminal/session.ts';
const SPEC = 'src/composables/ai/useAiAssistant.spec.ts';

// ── 1) SSH 写文件类型（真正的 ts2345）─────────────────────────────
// 1a 导入 ISshFileWriteRequest（上次已成功，会自动跳过）
edit(
    VUE,
    `import type { ISshFileReadPayload } from '@/types/tauri';`,
    `import type { ISshFileReadPayload, ISshFileWriteRequest } from '@/types/tauri';`,
    '1a SSH 写文件：补充 ISshFileWriteRequest 类型导入',
);

// 1b 收紧 createSshFileWriteRequest 参数为“写请求”的严格联合类型
edit(
    VUE,
    `  encoding: ISshFileReadPayload['encoding'],
  lineEnding: ISshFileReadPayload['lineEnding'],`,
    `  encoding: ISshFileWriteRequest['encoding'],
  lineEnding: ISshFileWriteRequest['lineEnding'],`,
    '1b SSH 写文件：收紧 createSshFileWriteRequest 参数类型',
);

// 1c 调用处把“读到的值”收窄回写请求的联合类型（边界 as，无 any / @ts-ignore / !）
edit(
    VUE,
    `        currentPreviewPayload.encoding,
        currentPreviewPayload.lineEnding,`,
    `        currentPreviewPayload.encoding as ISshFileWriteRequest['encoding'],
        currentPreviewPayload.lineEnding as ISshFileWriteRequest['lineEnding'],`,
    '1c SSH 写文件：调用处收窄 encoding / lineEnding',
);

// ── 2) session.ts 删除未使用常量（ts6133）─────────────────────────
edit(
    SESSION,
    `const TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS = 2000;
const TERMINAL_SCROLL_RECOVERY_DELAY_MS = 64;
const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;`,
    `const TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS = 2000;
const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;`,
    '2 session.ts：删除未使用的 TERMINAL_SCROLL_RECOVERY_DELAY_MS',
);

// ── 3) 测试文件删除未使用工厂 + 其类型导入（ts6133）───────────────
// 3a 删除未使用工厂 createAiEditOperation（含其后空行）
edit(
    SPEC,
    `const createAiEditOperation = (overrides: Partial<IAiEditOperation> = {}): IAiEditOperation => ({
  id: 'operation-rollback-1',
  taskId: 'thread-rollback',
  turnId: 'turn-rollback',
  kind: 'modify',
  path: 'D:/test/xiaojianc.sh',
  sourceSnapshotId: 'snapshot-before',
  beforeHash: 'fnv64:before',
  afterHash: 'fnv64:after',
  bytesBefore: 8,
  bytesAfter: 8,
  appliedAt: '2026-04-29T00:00:01.000Z',
  reason: '应用 AI 文件修改',
  toolCallId: null,
  pinned: false,
  ...overrides,
});

`,
    ``,
    '3a 测试：删除未使用工厂 createAiEditOperation',
);

// 3b 删除随之未使用的类型导入 IAiEditOperation
edit(
    SPEC,
    `  IAiEditListTimelineRequest,
  IAiEditOperation,
  IAiEditRevertTaskPayload,`,
    `  IAiEditListTimelineRequest,
  IAiEditRevertTaskPayload,`,
    '3b 测试：删除未使用的 IAiEditOperation 类型导入',
);

console.log(`\n完成：修改 ${changed} 处，跳过 ${skipped} 处。`);
console.log('接着请运行：pnpm lint && pnpm typecheck && pnpm test');