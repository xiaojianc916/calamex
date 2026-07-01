// 1.mjs — R4-B: 让附件内容真正进入 ACP prompt + 删除三个前端解析依赖
// 用法：置于仓库根目录，node 1.mjs
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const j = (...a) => a.join('\n');

function patch(rel, edits) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error('缺文件: ' + rel);
  const raw = readFileSync(p, 'utf8');
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  for (const [find, replace, label] of edits) {
    if (!s.includes(find)) throw new Error('❌ 匹配失败 [' + rel + ']: ' + label);
    s = s.replace(find, replace);
  }
  writeFileSync(p, crlf ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  console.log('✓ 改写 ' + rel + '（' + edits.length + ' 处）');
}

// ── 1) useAiAssistant.ts：去解析化 + 附件全文并入 prompt ──
patch('src/composables/ai/useAiAssistant.ts', [
  [
    "import { extractDocumentText, isDocumentAttachment } from './attachment-document-text';\n",
    "",
    '删除 attachment-document-text 导入',
  ],
  [
    "const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;\n",
    "",
    '删除 MAX_DOCUMENT_ATTACHMENT_BYTES 常量',
  ],
  [
    j(
      "    if (isDocumentAttachment(file)) {",
      "      if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {",
      "        errorMessage.value = `文档超过 ${formatBytes(MAX_DOCUMENT_ATTACHMENT_BYTES)}，请压缩或拆分后再试。`;",
      "        return false;",
      "      }",
      "",
      "      const documentText = await extractDocumentText(file).catch((): null => null);",
      "",
      "      if (documentText === null) {",
      "        errorMessage.value = '解析文档失败，请确认文件未损坏后重试。';",
      "        return false;",
      "      }",
      "",
      "      const trimmedText = documentText.trim();",
      "",
      "      if (!trimmedText) {",
      "        errorMessage.value = '未能从该文档中提取到文本（可能是扫描件或纯图片内容）。';",
      "        return false;",
      "      }",
      "",
      "      const id = `attachment:${normalizedName}:${file.lastModified}:${file.size}`;",
      "      const reference: IAiContextReference = {",
      "        id,",
      "        kind: 'search-result',",
      "        label: `附件 · ${normalizedName}`,",
      "        path: normalizedName,",
      "        range: null,",
      "        contentPreview: [",
      "          `文件名：${normalizedName}`,",
      "          `大小：${formatBytes(file.size)}`,",
      "          '内容（已从文档提取为纯文本）：',",
      "          clipText(trimmedText, MAX_CONTEXT_CHARS),",
      "        ].join('\\n'),",
      "        redacted: false,",
      "      };",
      "",
      "      replaceAttachedFile({",
      "        id,",
      "        name: normalizedName,",
      "        sizeLabel: formatBytes(file.size),",
      "        kind: 'text',",
      "        reference,",
      "      });",
      "",
      "      currentReferences.value = await buildReferences();",
      "      errorMessage.value = '';",
      "",
      "      return true;",
      "    }",
      "",
      "    if (isTextAttachment(file)) {",
    ),
    "    if (isTextAttachment(file)) {",
    '移除前端文档解析分支（pdf/docx/xlsx 不再前端解析）',
  ],
  [
    "          clipText(content, MAX_CONTEXT_CHARS),",
    "          content,",
    '文本附件不再截断到 12K（送全文）',
  ],
  [
    j(
      "    currentReferences.value = references;",
      "",
      "    aiThreadStore.patchActiveThreadEntries((entries) =>",
    ),
    j(
      "    currentReferences.value = references;",
      "",
      "    // 修复断链：把附件全文随标准 ACP session/prompt 一并送达模型。",
      "    // references.contentPreview 已含文本附件全文；图片仍只作 UI 预览、不并入文本 prompt。",
      "    const attachmentContextBlocks = references",
      "      .filter((reference) => reference.kind !== 'image-attachment')",
      "      .map((reference) =>",
      "        ['<附件 ' + reference.path + '>', reference.contentPreview, '</附件>'].join('\\n'),",
      "      )",
      "      .join('\\n\\n');",
      "    const promptText =",
      "      attachmentContextBlocks.length > 0",
      "        ? messageContent + '\\n\\n' + attachmentContextBlocks",
      "        : messageContent;",
      "",
      "    aiThreadStore.patchActiveThreadEntries((entries) =>",
    ),
    '发送前把附件内容折入 promptText（用户气泡仍只显示 messageContent）',
  ],
  [
    "    await executeExternalAgentRequest(backend, messageContent, titleThreadId, modeConfigValue);",
    "    await executeExternalAgentRequest(backend, promptText, titleThreadId, modeConfigValue);",
    '标准发送链路改用 promptText',
  ],
  [
    "    errorMessage.value = '当前只支持文本文件和图片作为 AI 上下文附件。';",
    "    errorMessage.value = 'AI 附件仅支持文本/代码文件与图片；PDF、Word、Excel 等二进制文档的解析已下线，请粘贴文本或另存为纯文本后再添加。';",
    '二进制文档改为诚实拒绝提示',
  ],
]);

// ── 2) 删除已无消费方的前端解析模块 ──
const dead = join(ROOT, 'src/composables/ai/attachment-document-text.ts');
if (existsSync(dead)) {
  rmSync(dead);
  console.log('✓ 删除 src/composables/ai/attachment-document-text.ts');
}

// ── 3) package.json：移除三个重解析依赖 ──
{
  const p = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(p, 'utf8'));
  const targets = ['pdfjs-dist', 'mammoth', 'read-excel-file'];
  const removed = [];
  for (const dep of targets) {
    if (pkg.dependencies && dep in pkg.dependencies) {
      delete pkg.dependencies[dep];
      removed.push(dep);
    }
  }
  writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('✓ package.json 移除依赖: ' + (removed.join(', ') || '（无，可能已删）'));
}

console.log('\n完成。接下来手动执行：');
console.log('  1) pnpm install            # 落实依赖删除，刷新 lockfile');
console.log('  2) pnpm typecheck && pnpm lint && pnpm test');