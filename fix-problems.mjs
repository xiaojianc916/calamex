// fix-problems.mjs —— 一次性修复 3 处问题
// 用法：在项目根目录执行  node fix-problems.mjs
import { readFileSync, writeFileSync } from 'node:fs';

let changed = 0;

function edit(file, label, before, after) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(after) && !text.includes(before)) {
        console.log(`· 跳过（已修复）：${label}`);
        return;
    }
    const count = text.split(before).length - 1;
    if (count === 0) throw new Error(`✗ 未找到锚点，已中止：${label}\n  文件：${file}`);
    if (count > 1) throw new Error(`✗ 锚点出现 ${count} 次（预期 1 次），已中止以免误改：${label}`);
    writeFileSync(file, text.replace(before, after), 'utf8');
    changed++;
    console.log(`✓ 已修复：${label}`);
}

// ── 修复 1：SshSidebarPanel.vue 的 encoding 类型不兼容（ts2345，红色）──
const vue = 'src/components/workbench/SshSidebarPanel.vue';

edit(vue, '1/3 SSH 写文件：补充 ISshFileWriteRequest 类型导入',
    `import type { ISshFileReadPayload } from '@/types/tauri';`,
    `import type { ISshFileReadPayload, ISshFileWriteRequest } from '@/types/tauri';`);

edit(vue, '2/3 SSH 写文件：收紧 createSshFileWriteRequest 参数类型',
    `  encoding: ISshFileReadPayload['encoding'],
  lineEnding: ISshFileReadPayload['lineEnding'],`,
    `  encoding: ISshFileWriteRequest['encoding'],
  lineEnding: ISshFileWriteRequest['lineEnding'],`);

edit(vue, '3/3 SSH 写文件：调用处把宽松 string 收窄到写入枚举',
    `        currentPreviewPayload.encoding,
        currentPreviewPayload.lineEnding,`,
    `        currentPreviewPayload.encoding as ISshFileWriteRequest['encoding'],
        currentPreviewPayload.lineEnding as ISshFileWriteRequest['lineEnding'],`);

// ── 修复 2：session.ts 未使用常量 TERMINAL_SCROLL_RECOVERY_DELAY_MS（ts6133）──
edit('src/terminal/session.ts',
    'session.ts：删除未使用常量 TERMINAL_SCROLL_RECOVERY_DELAY_MS',
    `const TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS = 2000;
const TERMINAL_SCROLL_RECOVERY_DELAY_MS = 64;
const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;`,
    `const TERMINAL_RUN_VISUAL_REORDER_TIMEOUT_MS = 2000;
const TERMINAL_LAYOUT_SCROLL_GUARD_RELEASE_MS = 180;`);

// ── 修复 3：useAiAssistant.spec.ts 未使用工厂 createAiEditOperation（ts6133）──
const spec = 'src/composables/ai/useAiAssistant.spec.ts';
{
    const fn = `const createAiEditOperation = (overrides: Partial<IAiEditOperation> = {}): IAiEditOperation => ({
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

`;
    let text = readFileSync(spec, 'utf8');
    if (!text.includes(fn)) {
        if (text.includes('const createAiEditOperation')) {
            throw new Error('✗ useAiAssistant.spec.ts：createAiEditOperation 内容与预期不符，已中止，请手动核对。');
        }
        console.log('· 跳过（已修复）：useAiAssistant.spec.ts 工厂 createAiEditOperation');
    } else {
        text = text.replace(fn, '');
        // 删完函数后，若 IAiEditOperation 仅剩类型导入这一处引用，则一并清理，避免新的 ts6133
        const importLine = '  IAiEditOperation,\n';
        if (text.includes(importLine)) {
            const withoutImport = text.replace(importLine, '');
            if (!withoutImport.includes('IAiEditOperation')) text = withoutImport;
        }
        writeFileSync(spec, text, 'utf8');
        changed++;
        console.log('✓ 已修复：useAiAssistant.spec.ts 删除未使用工厂 createAiEditOperation');
    }
}

console.log(`\n完成，本次改动 ${changed} 处。接着请运行： pnpm typecheck && pnpm test`);