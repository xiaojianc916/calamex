import {
  extractFileNameFromPath,
  previewHasResultItems,
  resolvePreviewCommand,
  resolvePreviewQuery,
} from './preview';
import {
  extractShellcheckDiagnosticCodes,
  formatShellcheckIssueAction,
  hasShellcheckPassSummary,
  hasShellcheckUnavailableSummary,
} from './shellcheck';
import {
  isWebSearchToolName,
  resolveWebSearchQuery,
  resolveWebSearchSources,
} from './web-search';
import type { IToolActionDescriptor, TToolLifecycleEvent } from './types';

type TToolPhase = 'running' | 'done' | 'failed';

type TToolResourceKind = 'none' | 'file' | 'query' | 'command';

/**
 * 单个具体工具的语义文案。每个工具一条，而不是按大类兜底。
 * - {name} 会被替换为该工具操作的资源名（文件名 / 搜索词 / 命令）。
 * - emptyDone 用于“完成但无结果”的搜索类工具。
 */
interface IToolPhrases {
  resource?: TToolResourceKind;
  running: string;
  done: string;
  failed: string;
  emptyDone?: string;
}

const RESOURCE_FALLBACK_LABEL: Record<Exclude<TToolResourceKind, 'none'>, string> = {
  file: '文件',
  query: '搜索词',
  command: '命令',
};

const READ_FILE_PHRASES: IToolPhrases = {
  resource: 'file',
  running: '正在查看 {name}',
  done: '已查看 {name}',
  failed: '查看失败 {name}',
};

const WRITE_FILE_PHRASES: IToolPhrases = {
  resource: 'file',
  running: '正在编辑 {name}',
  done: '编辑完成 {name}',
  failed: '编辑失败 {name}',
};

const COMMAND_PHRASES: IToolPhrases = {
  resource: 'command',
  running: '正在执行 {name}',
  done: '执行完成 {name}',
  failed: '执行失败