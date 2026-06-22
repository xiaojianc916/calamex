// scripts/fix-pdf-destroy.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/composables/ai/attachment-document-text.ts';
let s = readFileSync(path, 'utf8');

if (s.includes('await loadingTask.destroy();')) {
  console.log('· 已修复，跳过');
  process.exit(0);
}

const before =
  '  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;';
const after =
  '  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });\n' +
  '  const doc = await loadingTask.promise;';

if (!s.includes(before) || !s.includes('  await doc.destroy();')) {
  throw new Error('找不到锚点，请确认未手动改过该文件');
}

s = s.split(before).join(after).split('  await doc.destroy();').join('  await loadingTask.destroy();');
writeFileSync(path, s, 'utf8');
console.log('✓ 已修复 PDFDocumentProxy.destroy 类型错误');