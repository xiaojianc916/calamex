// 解析库的最小类型声明：mammoth 浏览器构建子路径 + pdfjs worker 的 ?url 资源导入。
declare module 'mammoth/mammoth.browser' {
  interface IMammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<IMammothResult>;
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<IMammothResult>;
}

declare module 'pdfjs-dist/build/pdf.worker.min.mjs?url' {
  const src: string;
  export default src;
}
