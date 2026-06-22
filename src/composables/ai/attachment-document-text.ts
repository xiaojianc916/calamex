// 文档附件正文提取：把 .docx / .pdf / .xlsx / .xls 解析成纯文本，
// 再走既有「文本附件」上下文链路。所有解析库均动态 import，不进主包。
//
// - .docx：mammoth(extractRawText)
// - .pdf：pdfjs-dist（逐页 getTextContent 拼接；扫描件无文本层 → 返回空串）
// - .xlsx/.xls：xlsx(SheetJS)，每个 sheet 转 CSV 后拼接
//
// 注意：旧版二进制 .doc 不在此列（无可靠浏览器端解析），仍按原文本逻辑处理。

const DOCUMENT_ATTACHMENT_EXTENSION_PATTERN = /\.(docx|pdf|xlsx|xls)$/i;

const DOCUMENT_ATTACHMENT_MIME_PATTERN =
  /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/vnd\.ms-excel)$/i;

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

const extractSpreadsheetText = async (buffer: ArrayBuffer): Promise<string> => {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, { type: 'array' });

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : '';
    return `# ${sheetName}\n${csv}`;
  }).join('\n\n');
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

  if (
    ext === 'xlsx' ||
    ext === 'xls' ||
    file.type.includes('spreadsheetml') ||
    file.type === 'application/vnd.ms-excel'
  ) {
    return extractSpreadsheetText(buffer);
  }

  return null;
};
