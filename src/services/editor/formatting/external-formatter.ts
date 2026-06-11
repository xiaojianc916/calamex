import type { IFormatter, IFormatterInput } from './types';

/**
 * 由后端 External 子进程 formatter 覆盖的语言集合。
 *
 * 与后端 `commands/format/registry.rs` 的语言→formatter 矩阵保持一致；
 * shell 不在此列——它由 WASM 版 shfmt（shfmtFormatter）处理，离线可用、无需外部二进制，
 * 在 resolveFormatter 中排在 External 之前优先命中。
 */
const EXTERNAL_FORMATTER_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'json',
  'css',
  'scss',
  'less',
  'html',
  'vue',
  'markdown',
  'yaml',
  'rust',
  'go',
  'python',
  'toml',
]);

/**
 * 调用后端 `format_document` 的端口；抽成依赖注入便于单测。
 * 默认实现经前端 I/O 唯一出口 tauriService；这里用动态 import 延迟加载，
 * 避免把整个 IPC 服务图拖进 formatting 层的单测，保持本模块可独立测试。
 */
export type TExternalFormatPort = (input: IFormatterInput) => Promise<string>;

const formatViaTauri: TExternalFormatPort = async ({ text, path, languageId }) => {
  const { tauriService } = await import('@/services/tauri');
  const payload = await tauriService.formatDocument({
    content: text,
    languageId,
    path: path ?? null,
  });
  return payload.content;
};

/**
 * 创建 External formatter：按语言委托后端子进程 formatter（prettier / biome / rustfmt …）。
 *
 * - supports：仅声明后端已登记的非 shell 语言。
 * - format：调用后端；后端未发现可用二进制时会原样回传 content（formatterId 为 None），
 *   因此表现为「无变化」而非抛错，管线据此退回 whitespace 兜底；真正的子进程错误才会抛出，
 *   交由管线做失败容忍处理。
 */
export const createExternalFormatter = (
  formatViaBackend: TExternalFormatPort = formatViaTauri,
): IFormatter => ({
  id: 'external',
  supports: (languageId) => EXTERNAL_FORMATTER_LANGUAGES.has(languageId),
  format: (input) => formatViaBackend(input),
});

export const externalFormatter: IFormatter = createExternalFormatter();
