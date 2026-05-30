import {
  APPLY_FILE_EDIT_TOOL_NAMES,
  COMMAND_TOOL_NAMES,
  CURRENT_FILE_TOOL_NAMES,
  DIRECTORY_READ_TOOL_NAMES,
  READ_FILE_TOOL_NAMES,
  SYMBOL_SEARCH_TOOL_NAMES,
  TEXT_SEARCH_TOOL_NAMES,
  WRITE_FILE_TOOL_NAMES,
} from './constants';
import {
  extractFileNameFromPath,
  previewHasResultItems,
  resolvePreviewCommand,
  resolvePreviewPath,
  resolvePreviewQuery,
} from './preview';
import {
  extractShellcheckDiagnosticCodes,
  formatShellcheckIssueAction,
  hasShellcheckPassSummary,
  hasShellcheckUnavailableSummary,
} from './shellcheck';
import { isMcpListToolsName } from './tool-icons';
import {
  isWebSearchToolName,
  resolveWebSearchQuery,
  resolveWebSearchSources,
} from './web-search';
import type { IToolActionDescriptor, TToolLifecycleEvent } from './types';
import { classifyRuntimeToolKind, type TAiRuntimeToolKind } from '@/constants/ai/runtime-tools';

interface IFallbackActionVerbs {
  running: string;
  done: string;
  failed: string;
}

const SYSTEM_FALLBACK_ACTION_VERBS: IFallbackActionVerbs = {
  running: '正在处理',
  done: '处理完成',
  failed: '处理失败',
};

/**
 * 兜底语义文案：当某个工具没有专属描述时，按运行时工具类别给出自然语言动作，
 * 避免再退化成“完成调用 + 工具名”这类机械模板。
 */
const FALLBACK_ACTION_VERBS: Partial<Record<TAiRuntimeToolKind, IFallbackActionVerbs>> = {
  search: { running: '正在搜索', done: '搜索完成', failed: '搜索失败' },
  read: { running: '正在读取', done: '读取完成', failed: '读取失败' },
  write: { running: '正在编辑', done: '编辑完成', failed: '编辑失败' },
  git: { running: '正在执行版本控制操作', done: '版本控制操作完成', failed: '版本控制操作失败' },
  browser: { running: '正在操作浏览器', done: '浏览器操作完成', failed: '浏览器操作失败' },
  terminal: { running: '正在执行命令', done: '命令执行完成', failed: '命令执行失败' },
  task: { running: '正在处理任务', done: '任务处理完成', failed: '任务处理失败' },
  network: { running: '正在联网请求', done: '联网请求完成', failed: '联网请求失败' },
  diagram: { running: '正在生成图示', done: '图示生成完成', failed: '图示生成失败' },
  symbol: { running: '正在分析符号', done: '符号分析完成', failed: '符号分析失败' },
  python: { running: '正在执行 Python', done: 'Python 执行完成', failed: 'Python 执行失败' },
  java: { running: '正在执行调试', done: '调试完成', failed: '调试失败' },
  memory: { running: '正在更新记忆', done: '记忆更新完成', failed: '记忆更新失败' },
  thinking: { running: '正在思考', done: '思考完成', failed: '思考失败' },
  system: SYSTEM_FALLBACK_ACTION_VERBS,
};

const resolveFallbackAction = (event: TToolLifecycleEvent, toolName: string): string => {
  const kind = classifyRuntimeToolKind(toolName);
  const verbs = FALLBACK_ACTION_VERBS[kind] ?? SYSTEM_FALLBACK_ACTION_VERBS;

  if (event.type === 'agent.tool.completed' && !event.ok) {
    return verbs.failed;
  }

  return event.type === 'agent.tool.started' ? verbs.running : verbs.done;
};

export const describeToolAction = (
  event: TToolLifecycleEvent,
  toolName: string,
  fallbackResourceLabel?: string,
): IToolActionDescriptor => {
  const resourceLabel =
    fallbackResourceLabel ??
    resolvePreviewPath(
      event.type === 'agent.tool.started' ? event.inputPreview : event.resultPreview,
    ) ??
    undefined;

  if (toolName === 'shellcheck') {
    if (event.type !== 'agent.tool.completed') {
      return {
        action: '语法校验',
        suppressMeta: true,
      };
    }

    if (hasShellcheckPassSummary(event.resultPreview)) {
      return {
        action: '语法校验已通过',
        suppressMeta: true,
      };
    }

    const diagnosticCodes = extractShellcheckDiagnosticCodes(event.resultPreview);

    if (diagnosticCodes.length > 0) {
      return {
        action: formatShellcheckIssueAction(diagnosticCodes),
        suppressMeta: true,
      };
    }

    if (hasShellcheckUnavailableSummary(event.resultPreview) || !event.ok) {
      return {
        action: '语法校验未完成',
        suppressMeta: true,
      };
    }

    return {
      action: '语法校验已完成',
      suppressMeta: true,
    };
  }

  if (isMcpListToolsName(toolName)) {
    return {
      action:
        event.type === 'agent.tool.started'
          ? '正在查找MCP工具集'
          : event.ok
            ? '成功获取MCP工具集'
            : '查找MCP工具集失败',
      suppressMeta: true,
    };
  }

  if (CURRENT_FILE_TOOL_NAMES.has(toolName)) {
    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: '当前文件读取失败',
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started' ? '正在读取当前文件' : '当前文件读取完成',
      suppressMeta: true,
    };
  }

  if (DIRECTORY_READ_TOOL_NAMES.has(toolName)) {
    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: '工作区目录读取失败',
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started' ? '正在读取工作区目录' : '工作区目录读取完成',
      suppressMeta: true,
    };
  }

  if (TEXT_SEARCH_TOOL_NAMES.has(toolName)) {
    const query =
      fallbackResourceLabel ??
      (event.type === 'agent.tool.started' ? resolvePreviewQuery(event.inputPreview) : null) ??
      '搜索词';

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: `未读取到 ${query}`,
        resourceLabel: query,
        suppressMeta: true,
      };
    }

    return {
      action:
        event.type === 'agent.tool.started'
          ? `正在搜索 ${query}`
          : previewHasResultItems(event.resultPreview)
            ? `成功读取到 ${query}`
            : `未读取到 ${query}`,
      resourceLabel: query,
      suppressMeta: true,
    };
  }

  if (SYMBOL_SEARCH_TOOL_NAMES.has(toolName)) {
    const query =
      fallbackResourceLabel ??
      (event.type === 'agent.tool.started' ? resolvePreviewQuery(event.inputPreview) : null) ??
      '搜索词';

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: '当前文件读取失败',
        resourceLabel: query,
        suppressMeta: true,
      };
    }

    return {
      action:
        event.type === 'agent.tool.started'
          ? `正在结构化搜索 ${query}`
          : previewHasResultItems(event.resultPreview)
            ? `成功搜索到 ${query}`
            : `未搜索到 ${query}`,
      resourceLabel: query,
      suppressMeta: true,
    };
  }

  if (APPLY_FILE_EDIT_TOOL_NAMES.has(toolName)) {
    const fileName =
      fallbackResourceLabel ??
      (event.type === 'agent.tool.started' ? extractFileNameFromPath(event.inputPreview) : null) ??
      '文件';

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: `编辑失败 ${fileName}`,
        resourceLabel: fileName,
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started' ? `正在编辑 ${fileName}` : `编辑完成 ${fileName}`,
      resourceLabel: fileName,
      suppressMeta: true,
    };
  }

  if (READ_FILE_TOOL_NAMES.has(toolName)) {
    const fileName =
      fallbackResourceLabel ??
      extractFileNameFromPath(
        event.type === 'agent.tool.started' ? event.inputPreview : event.resultPreview,
      ) ??
      null;

    if (fileName) {
      if (event.type === 'agent.tool.completed' && !event.ok) {
        return {
          action: `查看失败 ${fileName}`,
          resourceLabel: fileName,
          suppressMeta: true,
        };
      }

      return {
        action: event.type === 'agent.tool.started' ? `正在查看 ${fileName}` : `已查看 ${fileName}`,
        resourceLabel: fileName,
        suppressMeta: true,
      };
    }
  }

  if (WRITE_FILE_TOOL_NAMES.has(toolName)) {
    const fileName =
      fallbackResourceLabel ??
      extractFileNameFromPath(
        event.type === 'agent.tool.started' ? event.inputPreview : event.resultPreview,
      ) ??
      '文件';

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: `编辑失败 ${fileName}`,
        resourceLabel: fileName,
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started' ? `正在编辑 ${fileName}` : `编辑完成 ${fileName}`,
      resourceLabel: fileName,
      suppressMeta: true,
    };
  }

  if (COMMAND_TOOL_NAMES.has(toolName)) {
    const command =
      fallbackResourceLabel ??
      (event.type === 'agent.tool.started' ? resolvePreviewCommand(event.inputPreview) : null) ??
      '命令';

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: `执行失败 ${command}`,
        resourceLabel: command,
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started' ? `正在执行 ${command}` : `执行完成 ${command}`,
      resourceLabel: command,
      suppressMeta: true,
    };
  }

  if (toolName === 'get_current_time') {
    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: '当前时间读取失败',
        suppressMeta: true,
      };
    }

    return {
      action: event.type === 'agent.tool.started' ? '正在读取当前时间' : '当前时间读取完成',
      suppressMeta: true,
    };
  }

  if (isWebSearchToolName(toolName)) {
    const query =
      resolveWebSearchQuery(event.type === 'agent.tool.started' ? event.inputPreview : undefined) ??
      fallbackResourceLabel ??
      undefined;
    const webSearchSources = resolveWebSearchSources(
      event.type === 'agent.tool.completed' ? event.resultPreview : event.inputPreview,
    );

    if (event.type === 'agent.tool.completed' && !event.ok) {
      return {
        action: '联网搜索失败',
        resourceLabel: query,
        suppressMeta: true,
        webSearchSources,
      };
    }

    return {
      action:
        event.type === 'agent.tool.started'
          ? `正在联网搜索 ${query ?? '相关内容'}`
          : '联网搜索完成',
      resourceLabel: query,
      suppressMeta: true,
      webSearchSources,
    };
  }

  return {
    action: resolveFallbackAction(event, toolName),
    resourceLabel,
  };
};
