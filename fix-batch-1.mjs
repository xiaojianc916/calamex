#!/usr/bin/env node
/**
 * fix-batch-3-residual.mjs — 修复第三批残留问题
 *
 * 1. 移除 useShellWorkbenchView.ts 中引用已删除 MAX_DOCUMENT_NAV_HISTORY 的死代码
 *    （trimDocumentNavHistory + pickNextNavigableDocumentId 两个函数已被 composable 吸收）
 * 2. 修复 documents watcher 中关闭文档检测逻辑（遍历旧快照而非新快照）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ENCODING = 'utf-8';
let changes = 0;

function patchFile(relPath, patches) {
  const absPath = join(ROOT, relPath);
  if (!existsSync(absPath)) {
    console.warn(`  ⚠️ 文件不存在: ${relPath}`);
    return;
  }
  let content = readFileSync(absPath, ENCODING);
  let modified = false;
  for (const { oldStr, newStr, description } of patches) {
    if (!content.includes(oldStr)) {
      console.warn(`  ⚠️ 未找到匹配 (跳过): ${description}`);
      continue;
    }
    content = content.replace(oldStr, newStr);
    console.log(`  ✅ ${description}`);
    modified = true;
    changes++;
  }
  if (modified) {
    writeFileSync(absPath, content, ENCODING);
  }
}

patchFile('src/composables/useShellWorkbenchView.ts', [
  {
    description: '移除残留的 trimDocumentNavHistory 死代码（引用已删除的 MAX_DOCUMENT_NAV_HISTORY）',
    oldStr:
`  const trimDocumentNavHistory = (stack: string[]): string[] =>
    stack.slice(Math.max(0, stack.length - MAX_DOCUMENT_NAV_HISTORY));

  const pickNextNavigableDocumentId = (
    stackRef: typeof documentBackStack,
    currentDocumentId: string,
  ): string | null => {
    while (stackRef.value.length > 0) {
      const candidate = stackRef.value.pop();
      if (!candidate || candidate === currentDocumentId) {
        continue;
      }

      if (hasDocumentInEditorStore(candidate)) {
        return candidate;
      }
    }

    return null;
  };

  const navigateDocument`,
    newStr:
`  const navigateDocument`,
  },
  {
    description: '修复 documents watcher 关闭文档检测逻辑（遍历旧快照而非新快照）',
    oldStr:
`      const documentIdSet = new Set(documentIds);
      for (const id of documentIds) {
        if (!documentIdSet.has(id)) {
          docHistory.removeClosedDocument(id);
        }
      }
      // 也清理栈中已不存在的文档
      documentBackStack.value = documentBackStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
      documentForwardStack.value = documentForwardStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );`,
    newStr:
`      const documentIdSet = new Set(documentIds);
      // 遍历旧快照：找出已不在新文档列表中的文档 ID（即被关闭的文档）。
      if (previousDocumentIds) {
        for (const id of previousDocumentIds) {
          if (!documentIdSet.has(id)) {
            docHistory.removeClosedDocument(id);
          }
        }
      }
      // 也清理栈中已不存在的文档
      documentBackStack.value = documentBackStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );
      documentForwardStack.value = documentForwardStack.value.filter((documentId) =>
        documentIdSet.has(documentId),
      );`,
  },
]);

console.log(`\nDone. ${changes} patches applied.`);