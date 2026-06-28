import type { AnyWorkspace, WorkspaceFilesystem } from '@mastra/core/workspace';

// 不索引的目录名（依赖 / 构建产物 / 版本控制 / 缓存）。
// 该集合对任意工作区都安全：普通目录通常不含这些名字，命中即整目录跳过（连同其嵌套内容），
// 因此在 monorepo 下也能躲掉诸如 builtin-agent/node_modules、src-tauri/target 这类嵌套的大目录。
export const NON_INDEXABLE_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    'target',
    'dist',
    'build',
    'out',
    'coverage',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.parcel-cache',
    '.cache',
    '.venv',
    'venv',
    '__pycache__',
    '.mypy_cache',
    '.pytest_cache',
    '.gradle',
    '.idea',
    'vendor',
    'Pods',
    'bin',
    'obj',
]);

// 后台预热遍历的最大深度：比 Mastra getAllFiles 默认的 10 略深，兼顾嵌套 monorepo；
// 仍然有界，避免异常深的目录结构带来的耗时 / 递归风险。
export const WORKSPACE_INDEX_WALK_MAX_DEPTH = 12;

// 二进制判定：含 NUL 字节的内容几乎必为二进制。
// Node 以 utf-8 读取二进制不会抛错（只会得到替换字符），因此在“读失败即跳过”之外，
// 额外用 NUL 字节过滤，避免把二进制当文本灌进 BM25 索引。
export const isLikelyIndexableTextContent = (content: string): boolean => !content.includes('\u0000');

// 逐层遍历工作区文件，产出“相对 basePath、无前导斜杠的 POSIX 路径”（与 Mastra getAllFiles
// 及 read_file / search 工具的路径约定一致，保证搜索结果可直接定位 / 打开）。
// 在目录层用 denylist 剪枝（命中目录不递归其内部），并跳过符号链接目录以防环。
export const collectIndexableFilePaths = async (
    filesystem: WorkspaceFilesystem,
    denylist: ReadonlySet<string> = NON_INDEXABLE_DIRECTORY_NAMES,
    maxDepth: number = WORKSPACE_INDEX_WALK_MAX_DEPTH,
): Promise<string[]> => {
    const files: string[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth >= maxDepth) {
            return;
        }

        const entries = await filesystem.readdir(dir).catch(() => null);
        if (!entries) {
            // 读不了的目录直接跳过（权限不足 / 遍历期间被删除等）。
            return;
        }

        for (const entry of entries) {
            const fullPath = dir === '.' || dir === '' ? entry.name : `${dir}/${entry.name}`;
            if (entry.type === 'directory') {
                if (entry.isSymlink || denylist.has(entry.name)) {
                    continue;
                }
                await walk(fullPath, depth + 1);
            } else if (entry.type === 'file') {
                files.push(fullPath);
            }
        }
    };

    await walk('.', 0);
    return files;
};

// 并发 I/O 控制器：限制同时读取的文件数，避免一次 Promise.all 几千个 readFile 撑爆 fd。
// 无新依赖，纯手写信号量。
const runWithConcurrency = async <T>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<void>,
): Promise<void> => {
    if (items.length === 0) {
        return;
    }
    let cursor = 0;
    const concurrency = Math.min(limit, items.length);
    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const current = items[cursor] as T;
            cursor += 1;
            await fn(current);
        }
    };
    await Promise.allSettled(Array.from({ length: concurrency }, worker));
};

// BM25 预热并发读取文件数。8 是 I/O 密集型任务的常见并发度：
// 足以让磁盘调度器合并相邻请求，又不至于在低端机器上耗尽 fd。
const SEARCH_INDEX_WARM_CONCURRENCY = 8;

// 后台预热 BM25 索引：遍历（剪枝后）的全部文本文件并逐个 workspace.index()。
// 设计取舍（与用户确认一致，刻意从简）：
//  - 不用 autoIndexPaths：它无法排除目录、也不读 .gitignore，递归 getAllFiles 会 walk 进嵌套
//    node_modules / target；这里自行遍历并在目录层剪枝，任意布局 / 嵌套都能躲掉。
//  - 不分块：calamex 仅用 BM25（无 vectorStore），整文件入库即可，且文档 id 直接等于真实文件相对路径，
//    搜索结果可直接定位 / 打开；分块（#chunk-i）主要服务向量嵌入的 token 限制，这里无必要。
//  - 不持久化 / 不限速 / 不做缓存淘汰：BM25 为内存态，随工作区生命周期重建；几千文件量级亚秒~秒级即可建好。
//  - best-effort：任何单文件失败（二进制 / 读失败 / 竞态）都跳过，绝不向上抛错。
export const warmWorkspaceSearchIndex = async (workspace: AnyWorkspace): Promise<void> => {
    if (!workspace.canBM25) {
        return;
    }

    const filesystem = workspace.filesystem as WorkspaceFilesystem | undefined;
    if (!filesystem) {
        return;
    }

    const filePaths = await collectIndexableFilePaths(filesystem).catch(() => null);
    if (!filePaths) {
        return;
    }

    for (const filePath of filePaths) {
        let content: string;
        try {
            content = (await filesystem.readFile(filePath, { encoding: 'utf-8' })) as string;
        } catch {
            // 二进制 / 无法以 utf-8 读取 / 已被删除：跳过（与 Mastra indexFileForSearch 行为一致）。
            continue;
        }

        if (!isLikelyIndexableTextContent(content)) {
            continue;
        }

        try {
            await workspace.index(filePath, content);
        } catch {
            // 单文件索引失败不影响其余文件。
            continue;
        }
    }
};
