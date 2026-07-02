#!/usr/bin/env node
// scripts/fix-aipanelframe-comment.mjs
// 幂等修正：删除启动骨架(StartupAiWorkbenchShell)后，AiPanelFrame.vue 顶部注释失真。
// 用法：node scripts/fix-aipanelframe-comment.mjs        # dry-run，只预览
//       node scripts/fix-aipanelframe-comment.mjs --apply # 实际写盘
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPLY = process.argv.includes('--apply');
const FILE = resolve(process.cwd(), 'src/components/business/ai/shell/AiPanelFrame.vue');

// —— EOL 无关读写：匹配统一在 LF 上做，写回时还原原始换行符 ——
const readText = (p) => {
  const raw = readFileSync(p, 'utf8');
  return { nl: raw.includes('\r\n') ? '\r\n' : '\n', text: raw.replace(/\r\n/g, '\n') };
};
const toEol = (text, nl) => (nl === '\r\n' ? text.replace(/\n/g, '\r\n') : text);

// 新注释里独有的短语，作为“已应用”幂等标记（旧注释里没有“的通用结构与尺寸”）
const APPLIED_MARKER = '的通用结构与尺寸，';

// 整段失真注释：从首行锚点到末行锚点，中间(含引号)一律不敏感
const BLOCK_RE = /\/\/ 共享 AI 面板外壳[\s\S]*?既同源又不拖慢启动。/;

const NEW_COMMENT =
  '// AI 面板外壳：头部 provider 标记 + 操作按钮 + 内容区 + 底部 composer 的通用结构与尺寸，\n' +
  '// 供 AiAssistantPanel 复用。刻意保持轻量、不依赖任何 AI 子系统（useAiAssistant / CopilotKit 等），\n' +
  '// 会话线程、建议气泡、输入框等重内核全部通过插槽注入。';

let src;
try {
  src = readText(FILE);
} catch {
  console.error(`✗ 找不到文件：${FILE}（请在仓库根目录运行）`);
  process.exit(1);
}

if (src.text.includes(APPLIED_MARKER)) {
  console.log('✓ 已是新注释，无需改动（幂等跳过）。');
  process.exit(0);
}

const count = (src.text.match(new RegExp(BLOCK_RE, 'g')) || []).length;
if (count !== 1) {
  console.error(`✗ 注释锚点命中 ${count} 次（应为 1），中止。文件可能已变动，请人工核对。`);
  process.exit(1);
}

const nextText = src.text.replace(BLOCK_RE, NEW_COMMENT);
if (nextText === src.text) {
  console.error('✗ 替换后内容无变化，中止。');
  process.exit(1);
}

if (!APPLY) {
  console.log('— DRY RUN（未写盘，加 --apply 生效）—');
  console.log('将把 AiPanelFrame.vue 顶部 7 行失真注释替换为 3 行新注释。');
  process.exit(0);
}

writeFileSync(FILE, toEol(nextText, src.nl), 'utf8');
console.log(`✓ 已更新：${FILE}`);