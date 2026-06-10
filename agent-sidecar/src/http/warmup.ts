/**
 * 过渡再导出垫片：warmup 逻辑已迁出至 models/llm-warmup.ts（LLM 连接预热与 HTTP 无关）。
 * 本文件仅为旧 HTTP 栈（server.ts / server/http.ts）在删除前保留既有导入路径，
 * 待 http/ 整体删除时一并移除。单一事实来源在 models/llm-warmup.ts，本处无逻辑。
 */
export * from '../models/llm-warmup.js';
