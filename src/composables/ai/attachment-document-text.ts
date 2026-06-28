// 文档附件正文提取：把 .docx / .pdf / .xlsx 解析成纯文本，
// 再走既有「文本附件」上下文链路。所有解析库均动态 import，不进主包。
//
// - .docx：mammoth(extractRawText)
// - .pdf：pdfjs-dist（逐页 getTextContent 拼接；扫描件无文本层 → 返回空串）
// - .xlsx：read-excel-file（逐 sheet 读出行，再转 CSV 拼接）
//
// 注意：read-excel-file 仅支持 OOXML 的 .xlsx；旧版二进制 .xls / .doc 不在此列
//（无可靠浏览器端解析），仍按原文本逻辑处理。

const DOCUMENT_ATTACHMENT_EXTENSION_PATTERN = /\.(docx|pdf|xlsx)$/i;

const DOCUMENT_ATTACHMENT_MIME_PATTERN =
  /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/i;

export const isDocumentAttachment = (file: File): boolean =>
  DOCUMENT_ATTACHMENT_MIME_PATTERN.test(file.type) ||
  DOCUMENT_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

const getExtension = (fileName: string): string => fileName.split('.').pop()?.toLowerCase() ?? '';

const extractDocxText = async (buffer: ArrayBuffer): Promise<string> => {
  const mammoth = await import('mammoth/mammoth.browser');
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value ?? '';
};

const extractPdfText = async (buffer: ArrayBuffer): Promise<string> => {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const doc = await loadingTask.promise;
  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }

  await loadingTask.destroy();
  return pages.join('\n\n');
};

const toCsvCell = (cell: unknown): string => {
  if (cell === null || cell === undefined) {
    return '';
  }

  const text = cell instanceof Date ? cell.toISOString() : String(cell);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const extractSpreadsheetText = async (buffer: ArrayBuffer): Promise<string> => {
  const { default: readXlsxFile } = await import('read-excel-file');
  const blob = new Blob([buffer]);
  const sheets = await readXlsxFile(blob, { getSheets: true });

  const sections = await Promise.all(
    sheets.map(async ({ name }): Promise<string> => {
      const rows = await readXlsxFile(blob, { sheet: name });
      const csv = rows.map((row) => row.map(toCsvCell).join(',')).join('\n');
      return `# ${name}\n${csv}`;
    }),
  );

  return sections.join('\n\n');
};

export const extractDocumentText = async (file: File): Promise<string | null> => {
  const buffer = await file.arrayBuffer().catch((): null => null);

  if (!buffer) {
    return null;
  }

  const ext = getExtension(file.name);

  if (ext === 'docx' || file.type.includes('wordprocessingml')) {
    return extractDocxText(buffer);
  }

  if (ext === 'pdf' || file.type === 'application/pdf') {
    return extractPdfText(buffer);
  }

  if (ext === 'xlsx' || file.type.includes('spreadsheetml')) {
    return extractSpreadsheetText(buffer);
  }

  return null;
};
