// fix-review-round.mjs
// 用途：批量应用本轮代码审查中「零风险」的两处修复。
//   1) useShellWorkbenchView.ts: documents[adjacentDocument] -> documents[adjacentIndex]（修 TDZ 崩溃）
//   2) useWorkspacePathSuggestions.ts: 删除重复的 JSDoc 注释块
// 特点：幂等（已修过则跳过）、无备份文件、有日志。跑完确认 git diff 无误后可删除本文件。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

/** 安全的单次字符串替换；找不到 from 时报错，避免静默失效。 */
function replaceOnce(content, from, to, label) {
  if (content.includes(to) && !content.includes(from)) {
    console.log(`  ⏭  [${label}] 已是修复后状态，跳过`);
    return { content, changed: false };
  }
  if (!content.includes(from)) {
    console.warn(`  ⚠️  [${label}] 未找到目标文本，可能源码已变动，请人工核对`);
    return { content, changed: false };
  }
  const occurrences = content.split(from).length - 1;
  if (occurrences > 1) {
    console.warn(`  ⚠️  [${label}] 目标文本出现 ${occurrences} 次，为安全起见跳过，请人工核对`);
    return { content, changed: false };
  }
  console.log(`  ✅ [${label}] 已替换`);
  return { content: content.replace(from, to), changed: true };
}

function patchFile(relPath, patches) {
  const abs = join(root, relPath);
  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    console.warn(`⚠️  找不到文件，跳过: ${relPath}`);
    return;
  }
  console.log(`\n📄 ${relPath}`);
  let changedAny = false;
  for (const p of patches) {
    const res = replaceOnce(content, p.from, p.to, p.label);
    content = res.content;
    changedAny = changedAny || res.changed;
  }
  if (changedAny) {
    writeFileSync(abs, content, 'utf8');
    console.log(`  💾 已写回`);
  } else {
    console.log(`  （无改动）`);
  }
}

// ---- 修复 1：文档相邻导航 TDZ 崩溃 -------------------------------------------
patchFile('src/composables/useShellWorkbenchView.ts', [
  {
    label: 'adjacentDocument -> adjacentIndex',
    from: 'const adjacentDocument = workbench.editorStore.documents[adjacentDocument];',
    to: 'const adjacentDocument = workbench.editorStore.documents[adjacentIndex];',
  },
]);

// ---- 修复 2：删除重复 JSDoc 注释块 -------------------------------------------
const dupComment =
  `/**\n` +
  ` * 以下三个辅助函数工作在相对路径段上，不经过 path.ts 的 normalizeFileSystemPath，\n` +
  ` * 因为后者会额外做 verbatim 前缀剥离 + 大小写折叠，会改变相对段的语义。\n` +
  ` * 仅做分隔符归一化和首尾修剪，保留原始段的内容。\n` +
  ` */\n`;
patchFile('src/composables/useWorkspacePathSuggestions.ts', [
  {
    label: '删除重复 JSDoc 块',
    from: dupComment,
    to: '',
  },
]);

console.log('\n完成。请运行：pnpm biome check --write && pnpm typecheck 验证。');