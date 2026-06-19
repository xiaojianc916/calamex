import { joinFileSystemPath } from '@/utils/file/path';

/** 建议项的种类，与文件图标组件保持一致。 */
export type TPathSuggestionKind = 'file' | 'directory';

export interface IPathSuggestion {
  /** 真正写入输入框的相对路径；目录以 '/' 结尾，便于继续逐级下钻。 */
  insertValue: string;
  /** 主显示文本：目录名或文件名。 */
  label: string;
  /** 次要说明：所在目录的相对路径，可能为空字符串。 */
  detail: string;
  kind: TPathSuggestionKind;
}

export interface IPatternTokenRange {
  start: number;
  end: number;
  leadingWhitespaceLength: number;
  core: string;
}

export interface IPatternSuggestionAcceptResult {
  value: string;
  caret: number;
}

interface IUseWorkspacePathSuggestionsOptions {
  workspaceRootPath: () => string | null;
  isDesktopRuntime: () => boolean;
  matchCase: () => boolean;
  debounceMs?: number;
  limit?: number;
}

const DEFAULT_DEBOUNCE_MS = 180;
const DEFAULT_SUGGESTION_LIMIT = 40;
export const PATH_SUGGESTION_DIRECTORY_CACHE_LIMIT = 64;
export const PATH_SUGGESTION_FILE_SEARCH_CACHE_LIMIT = 64;

/**
 * 以下三个辅助函数工作在「相对路径段」上，不经过 path.ts 的 normalizeFileSystemPath，
 * 因为后者会额外做 verbatim 前缀剥离 + 大小写折叠，会改变相对段的语义。
 * 仅做分隔符归一化和首尾修剪，保留原始段的内容。
 */
/**
 * 以下三个辅助函数工作在相对路径段上，不经过 path.ts 的 normalizeFileSystemPath，
 * 因为后者会额外做 verbatim 前缀剥离 + 大小写折叠，会改变相对段的语义。
 * 仅做分隔符归一化和首尾修剪，保留原始段的内容。
 */
const normalizeSlashes = (value: string): string => value.replace(/\\/gu, '/');
const stripTrailingSlashes = (value: string): string => value.replace(/[\\/]+$/u, '');
const stripLeadingSlashes = (value: string): string => value.replace(/^[\\/]+/u, '');

const getFileName = (relativePath: string): string => {
  const segments = normalizeSlashes(relativePath).split('/').filter(Boolean);
  return segments.at(-1) ?? relativePath;
};

const getParentPath = (relativePath: string): string => {
  const segments = normalizeSlashes(relativePath).split('/').filter(Boolean);
  return segments.length <= 1 ? '' : segments.slice(0, -1).join('/');
};

// 包含/排除输入框是以逗号或换行分隔的 glob 列表，补全只应作用于「光标所在的那一段」。
// 这里切出当前 token 的范围、其前导空白长度，以及去掉首尾空白后的核心文本。
export const resolvePatternToken = (value: string, caret: number): IPatternTokenRange => {
  const safeCaret = Math.max(0, Math.min(caret, value.length));

  let start = 0;
  for (let index = safeCaret - 1; index >= 0; index -= 1) {
    const character = value[index];
    if (character === ',' || character === '\n') {
      start = index + 1;
      break;
    }
  }

  let end = value.length;
  for (let index = safeCaret; index < value.length; index += 1) {
    const character = value[index];
    if (character === ',' || character === '\n') {
      end = index;
      break;
    }
  }

  const raw = value.slice(start, end);
  const leadingWhitespaceLength = raw.length - raw.replace(/^\s+/u, '').length;

  return { start, end, leadingWhitespaceLength, core: raw.trim() };
};

// 用选中的建议替换「当前 token」，保留同一输入框内其余逗号分隔项及原有前导空白。
export const applyPatternSuggestion = (
  value: string,
  caret: number,
  insertValue: string,
): IPatternSuggestionAcceptResult => {
  const token = resolvePatternToken(value, caret);
  const leadingWhitespace = value.slice(token.start, token.start + token.leadingWhitespaceLength);
  const nextToken = `${leadingWhitespace}${insertValue}`;
  const nextValue = `${value.slice(0, token.start)}${nextToken}${value.slice(token.end)}`;

  return { value: nextValue, caret: token.start + nextToken.length };
};

export const useWorkspacePathSuggestions = (options: IUseWorkspacePathSuggestionsOptions) => {
  const suggestions = ref<IPathSuggestion[]>([]);
  const open = ref(false);
  const loading = ref(false);
  const activeIndex = ref(-1);

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const suggestionLimit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;

  // 目录列表缓存：键为目录的相对路径（'' 表示工作区根）。同一工作区会话内复用以减少 IPC。
  // 使用固定容量 LRU，避免在大仓库里逐级浏览很多目录后缓存无界增长。
  let directoryEntriesCache = new Map<string, IWorkspaceEntry[]>();
  // 文件名全局模糊搜索缓存：键为 caseSensitive + query + limit。用户在输入框内来回编辑同一
  // query 或失焦/聚焦时可复用结果，减少重复 searchWorkspace IPC；同样用 LRU 控制内存。
  let fileSearchCache = new Map<string, IPathSuggestion[]>();
  let cachedRootPath: string | null = null;

  // 防抖 + 单调递增 requestId + AbortController：沿用搜索面板既有的竞态范式，
  // 丢弃迟到的响应、中止仍在途的模糊搜索请求。
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestSequence = 0;
  let activeAbortController: AbortController | null = null;

  const resetCacheIfRootChanged = (rootPath: string): void => {
    if (cachedRootPath !== rootPath) {
      cachedRootPath = rootPath;
      directoryEntriesCache = new Map<string, IWorkspaceEntry[]>();
      fileSearchCache = new Map<string, IPathSuggestion[]>();
    }
  };

  const listDirectoryEntries = async (
    rootPath: string,
    relativeDirectory: string,
  ): Promise<IWorkspaceEntry[]> => {
    const cached = getBoundedCacheValue(directoryEntriesCache, relativeDirectory);
    if (cached) {
      return cached;
    }

    const absolutePath = joinFileSystemPath(rootPath, relativeDirectory);
    const payload = await tauriService.listWorkspaceEntries(absolutePath, rootPath);
    setBoundedCacheValue(
      directoryEntriesCache,
      relativeDirectory,
      payload.entries,
      PATH_SUGGESTION_DIRECTORY_CACHE_LIMIT,
    );

    return payload.entries;
  };

  const matchesPrefix = (name: string, prefix: string, caseSensitive: boolean): boolean => {
    if (!prefix) {
      return true;
    }

    return caseSensitive
      ? name.startsWith(prefix)
      : name.toLowerCase().startsWith(prefix.toLowerCase());
  };

  const toEntrySuggestion = (
    entry: IWorkspaceEntry,
    relativeDirectory: string,
  ): IPathSuggestion => {
    const isDirectory = entry.kind === 'directory';
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

    return {
      insertValue: isDirectory ? `${relativePath}/` : relativePath,
      label: entry.name,
      detail: relativeDirectory,
      kind: isDirectory ? 'directory' : 'file',
    };
  };

  const buildFileSearchCacheKey = (core: string, caseSensitive: boolean): string =>
    `${caseSensitive ? 'case' : 'fold'}\u0000${suggestionLimit}\u0000${core}`;

  const searchFileNameSuggestions = async (
    rootPath: string,
    normalizedCore: string,
    caseSensitive: boolean,
    abortSignal: AbortSignal,
  ): Promise<IPathSuggestion[]> => {
    const cacheKey = buildFileSearchCacheKey(normalizedCore, caseSensitive);
    const cached = getBoundedCacheValue(fileSearchCache, cacheKey);
    if (cached) {
      return cached;
    }

    const payload = await tauriService.searchWorkspace(
      {
        workspaceRootPath: rootPath,
        query: normalizedCore,
        scope: 'file-name',
        matchCase: caseSensitive,
        wholeWord: false,
        useRegex: false,
        useStructural: false,
        includePatterns: [],
        excludePatterns: [],
        limit: suggestionLimit,
      },
      { signal: abortSignal },
    );

    const nextSuggestions = payload.results.map((result) => {
      const relativePath = normalizeSlashes(result.relativePath);
      return {
        insertValue: relativePath,
        label: getFileName(relativePath),
        detail: getParentPath(relativePath),
        kind: 'file' as const,
      };
    });

    setBoundedCacheValue(
      fileSearchCache,
      cacheKey,
      nextSuggestions,
      PATH_SUGGESTION_FILE_SEARCH_CACHE_LIMIT,
    );
    return nextSuggestions;
  };

  const buildSuggestions = async (
    rootPath: string,
    core: string,
    caseSensitive: boolean,
    abortSignal: AbortSignal,
  ): Promise<IPathSuggestion[]> => {
    const normalizedCore = normalizeSlashes(core);
    const lastSlashIndex = normalizedCore.lastIndexOf('/');

    if (lastSlashIndex >= 0) {
      // 形如 "src/com"：在目录 "src" 内按前缀 "com" 精确补全（只读这一层目录）。
      const relativeDirectory = stripTrailingSlashes(normalizedCore.slice(0, lastSlashIndex));
      const namePrefix = normalizedCore.slice(lastSlashIndex + 1);
      const entries = await listDirectoryEntries(rootPath, relativeDirectory);

      return entries
        .filter((entry) => matchesPrefix(entry.name, namePrefix, caseSensitive))
        .slice(0, suggestionLimit)
        .map((entry) => toEntrySuggestion(entry, relativeDirectory));
    }

    // 无 "/"：根目录前缀匹配（便于逐级下钻）+ 全局模糊文件名（复用后端 nucleo）兜底。
    const seenInsertValues = new Set<string>();
    const merged: IPathSuggestion[] = [];

    const pushSuggestion = (suggestion: IPathSuggestion): void => {
      if (seenInsertValues.has(suggestion.insertValue)) {
        return;
      }

      seenInsertValues.add(suggestion.insertValue);
      merged.push(suggestion);
    };

    const rootEntries = await listDirectoryEntries(rootPath, '');
    for (const entry of rootEntries) {
      if (matchesPrefix(entry.name, normalizedCore, caseSensitive)) {
        pushSuggestion(toEntrySuggestion(entry, ''));
      }
    }

    if (normalizedCore) {
      const fileSuggestions = await searchFileNameSuggestions(
        rootPath,
        normalizedCore,
        caseSensitive,
        abortSignal,
      );
      for (const suggestion of fileSuggestions) {
        pushSuggestion(suggestion);
      }
    }

    return merged.slice(0, suggestionLimit);
  };

  const close = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    requestSequence += 1;
    activeAbortController?.abort();
    activeAbortController = null;
    loading.value = false;
    open.value = false;
    suggestions.value = [];
    activeIndex.value = -1;
  };

  const runRequest = async (value: string, caret: number): Promise<void> => {
    const rootPath = options.workspaceRootPath();
    if (!options.isDesktopRuntime() || !rootPath) {
      close();
      return;
    }

    resetCacheIfRootChanged(rootPath);

    const token = resolvePatternToken(value, caret);
    const caseSensitive = options.matchCase();

    const sequence = requestSequence + 1;
    requestSequence = sequence;
    activeAbortController?.abort();
    const abortController = new AbortController();
    activeAbortController = abortController;
    loading.value = true;

    try {
      const nextSuggestions = await buildSuggestions(
        rootPath,
        token.core,
        caseSensitive,
        abortController.signal,
      );

      if (sequence !== requestSequence) {
        return;
      }

      suggestions.value = nextSuggestions;
      open.value = nextSuggestions.length > 0;
      activeIndex.value = nextSuggestions.length > 0 ? 0 : -1;
    } catch {
      // 建议属于「辅助输入」能力：失败时静默降级为无建议，绝不打断键入或弹出错误。
      if (sequence !== requestSequence) {
        return;
      }

      suggestions.value = [];
      open.value = false;
      activeIndex.value = -1;
    } finally {
      if (sequence === requestSequence) {
        loading.value = false;
        activeAbortController = null;
      }
    }
  };

  const request = (value: string, caret: number): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runRequest(value, caret);
    }, debounceMs);
  };

  const moveActive = (delta: number): void => {
    const count = suggestions.value.length;
    if (!open.value || count === 0) {
      return;
    }

    activeIndex.value = (activeIndex.value + delta + count) % count;
  };

  const accept = (
    index: number,
    value: string,
    caret: number,
  ): (IPatternSuggestionAcceptResult & { suggestion: IPathSuggestion }) | null => {
    const suggestion = suggestions.value[index];
    if (!suggestion) {
      return null;
    }

    return { ...applyPatternSuggestion(value, caret, suggestion.insertValue), suggestion };
  };

  const dispose = (): void => {
    close();
    directoryEntriesCache = new Map<string, IWorkspaceEntry[]>();
    fileSearchCache = new Map<string, IPathSuggestion[]>();
    cachedRootPath = null;
  };

  return {
    suggestions,
    open,
    loading,
    activeIndex,
    request,
    close,
    moveActive,
    accept,
    dispose,
  };
};
