import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentBrowser } from '@mastra/agent-browser';
import type { MastraBrowser } from '@mastra/core/browser';
import { TokenLimiterProcessor, UnicodeNormalizer, type InputProcessorOrWorkflow, type OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { LocalFilesystem, LocalSandbox, Workspace, WORKSPACE_TOOLS, type AnyWorkspace, type CommandResult, type ExecuteCommandOptions, type WorkspaceToolsConfig } from '@mastra/core/workspace';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import type { IAgentContextReferenceInput, IAgentRuntimeInput } from './contracts/runtime-input.js';
import type { IMastraTextModeExecutionPlan, IMastraToolLoadPlan, TMastraToolProfile } from './types.js';
import { MASTRA_WORKSPACE_REDACTED_PREVIEW_TOOL_NAMES, WINDOWS_POWERSHELL_CORE_RELATIVE_PATH, WINDOWS_POWERSHELL_RELATIVE_PATH } from './types.js';
import { toNonEmptyString } from './utils.js';
import { resolveWorkspaceDirectory } from './context/context.js';
import { decideSensitivePathToolPermission, type IToolPermissionPolicy } from './policy/tool-permission-policy.js';
import { warmWorkspaceSearchIndex } from './search-index.js';
import { createWorkspaceBm25TokenizeOptions } from './bm25-tokenizer.js';

export const isWindowsRuntime = (): boolean => process.platform === 'win32';

export const AGENT_SIDECAR_INPUT_TOKEN_LIMIT_ENV = 'AGENT_SIDECAR_INPUT_TOKEN_LIMIT';
export const DEFAULT_MASTRA_INPUT_TOKEN_LIMIT = 64_000;
export const MIN_MASTRA_INPUT_TOKEN_LIMIT = 4_096;

const WORKSPACE_SENSITIVE_PATH_POLICY: IToolPermissionPolicy = {
    defaultMode: 'allow',
};

export interface IWorkspaceToolApprovalContext {
    args: Record<string, unknown>;
}

export const extractWorkspaceToolPathInput = (args: unknown): string | null => {
    if (!args || typeof args !== 'object') {
        return null;
    }

    const path = (args as Record<string, unknown>).path;
    return typeof path === 'string' && path.trim().length > 0 ? path : null;
};

export const createWorkspaceSensitivePathApprovalGate = (
    toolName: string,
    defaultRequiresApproval: boolean,
): ((context: IWorkspaceToolApprovalContext) => boolean) => ({ args }) => {
    const path = extractWorkspaceToolPathInput(args);
    if (!path) {
        return defaultRequiresApproval;
    }

    const permission = decideSensitivePathToolPermission({
        toolName,
        inputs: [path],
        policy: WORKSPACE_SENSITIVE_PATH_POLICY,
    });

    return defaultRequiresApproval || permission.kind !== 'allow';
};

export const resolveWindowsPowerShellExecutable = (): string => {
    const systemRoot = toNonEmptyString(process.env.SystemRoot)
        ?? toNonEmptyString(process.env.WINDIR)
        ?? 'C:\\Windows';
    const programFiles = toNonEmptyString(process.env.ProgramFiles)
        ?? 'C:\\Program Files';
    const localAppData = toNonEmptyString(process.env.LOCALAPPDATA);
    const powerShellCoreCandidates = [
        `${programFiles}\\${WINDOWS_POWERSHELL_CORE_RELATIVE_PATH}`,
        ...(localAppData ? [`${localAppData}\\Microsoft\\WindowsApps\\pwsh.exe`] : []),
    ];
    const installedPowerShellCore = powerShellCoreCandidates.find((path) => existsSync(path));

    return installedPowerShellCore
        ? installedPowerShellCore
        : `${systemRoot}\\${WINDOWS_POWERSHELL_RELATIVE_PATH}`;
};

export const isWindowsPowerShellCoreExecutable = (value: string): boolean =>
    /(?:^|\\)pwsh\.exe$/iu.test(value);

export const isSimpleDirectoryListCommand = (command: string): boolean =>
    /^(?:dir|ls|gci|get-childitem)(?:\s+(?:\.|-force))*\s*$/iu.test(command.trim());

export const prepareWindowsPowerShellCommand = (command: string): string => {
    const normalized = command.trim();

    if (isSimpleDirectoryListCommand(normalized)) {
        return 'Get-ChildItem -Force | Format-Table Mode,LastWriteTime,Length,Name -AutoSize | Out-String -Width 4096';
    }

    return command;
};

export const buildWindowsHostPath = (): string => {
    const systemRoot = toNonEmptyString(process.env.SystemRoot)
        ?? toNonEmptyString(process.env.WINDIR)
        ?? 'C:\\Windows';
    const existingPath = toNonEmptyString(process.env.PATH);
    const localAppData = toNonEmptyString(process.env.LOCALAPPDATA);
    const requiredPaths = [
        `${systemRoot}\\System32`,
        systemRoot,
        `${systemRoot}\\System32\\Wbem`,
        `${toNonEmptyString(process.env.ProgramFiles) ?? 'C:\\Program Files'}\\PowerShell\\7`,
        ...(localAppData ? [`${localAppData}\\Microsoft\\WindowsApps`] : []),
        `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    ];
    const mergedPath = existingPath
        ? [...requiredPaths, existingPath]
        : requiredPaths;

    return mergedPath.join(';');
};

export const normalizeCommandOutputNewlines = (value: string): string =>
    value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');

export const decodeUtf8CommandChunk = (
    decoder: TextDecoder,
    chunk?: Buffer,
): string => normalizeCommandOutputNewlines(decoder.decode(chunk, { stream: Boolean(chunk) }));

export const createWindowsPowerShellDecoder = (powerShellExecutable: string): TextDecoder =>
    new TextDecoder(isWindowsPowerShellCoreExecutable(powerShellExecutable) ? 'utf-8' : 'gb18030');

export const executeWindowsHostCommand = async (
    command: string,
    options?: ExecuteCommandOptions,
): Promise<CommandResult> => {
    const startedAt = Date.now();
    const powerShellExecutable = resolveWindowsPowerShellExecutable();
    const preparedCommand = prepareWindowsPowerShellCommand(command);
    const args = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-OutputFormat',
        'Text',
        '-Command',
        preparedCommand,
    ];
    const env = {
        ...createHostCommandEnv(),
        ...options?.env,
    };
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    const stdoutDecoder = createWindowsPowerShellDecoder(powerShellExecutable);
    const stderrDecoder = createWindowsPowerShellDecoder(powerShellExecutable);

    return await new Promise<CommandResult>((resolveResult) => {
        const child = spawn(powerShellExecutable, args, {
            cwd: options?.cwd,
            env,
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: options?.abortSignal,
        });
        let settled = false;
        const timeoutId = options?.timeout
            ? setTimeout(() => {
                timedOut = true;
                killed = child.kill();
            }, options.timeout)
            : null;
        const finish = (exitCode: number): void => {
            if (settled) {
                return;
            }

            settled = true;

            const remainingStdout = decodeUtf8CommandChunk(stdoutDecoder);
            const remainingStderr = decodeUtf8CommandChunk(stderrDecoder);

            if (remainingStdout) {
                stdout += remainingStdout;
                options?.onStdout?.(remainingStdout);
            }

            if (remainingStderr) {
                stderr += remainingStderr;
                options?.onStderr?.(remainingStderr);
            }

            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            resolveResult({
                command,
                success: exitCode === 0,
                exitCode,
                stdout,
                stderr,
                executionTimeMs: Date.now() - startedAt,
                ...(timedOut ? { timedOut } : {}),
                ...(killed ? { killed } : {}),
            });
        };

        child.stdout?.on('data', (chunk: Buffer) => {
            const decoded = decodeUtf8CommandChunk(stdoutDecoder, chunk);
            stdout += decoded;
            options?.onStdout?.(decoded);
        });

        child.stderr?.on('data', (chunk: Buffer) => {
            const decoded = decodeUtf8CommandChunk(stderrDecoder, chunk);
            stderr += decoded;
            options?.onStderr?.(decoded);
        });

        child.on('error', (error) => {
            const message = normalizeCommandOutputNewlines(error.message);
            stderr += message;
            options?.onStderr?.(message);
            finish(1);
        });

        child.on('close', (code, signal) => {
            if (signal && code === null) {
                finish(timedOut ? 124 : 128);
                return;
            }

            finish(code ?? 0);
        });
    });
};

export const createHostCommandEnv = (): NodeJS.ProcessEnv => ({
    PATH: isWindowsRuntime() ? buildWindowsHostPath() : process.env.PATH,
    ...(isWindowsRuntime() ? {
        ComSpec: process.env.ComSpec,
        PATHEXT: process.env.PATHEXT,
        SystemDrive: process.env.SystemDrive,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        USERPROFILE: process.env.USERPROFILE,
        WINDIR: process.env.WINDIR,
    } : {}),
});

export const createHostLocalSandbox = (
    options: ConstructorParameters<typeof LocalSandbox>[0],
): LocalSandbox => {
    const sandbox = new LocalSandbox({
        ...options,
        isolation: 'none',
    });
    const executeCommand = sandbox.executeCommand;

    if (!executeCommand) {
        return sandbox;
    }

    sandbox.executeCommand = async (
        command: string,
        args?: string[],
        options?: ExecuteCommandOptions,
    ): Promise<CommandResult> => {
        const shouldUseNativeWindowsExecution = isWindowsRuntime() && (!args || args.length === 0);

        if (shouldUseNativeWindowsExecution) {
            return await executeWindowsHostCommand(command, options);
        }

        const result = await executeCommand.call(sandbox, command, args, options);

        return {
            ...result,
            command,
        };
    };

    return sandbox;
};

export const shouldRedactWorkspacePreview = (toolName: string): boolean =>
    MASTRA_WORKSPACE_REDACTED_PREVIEW_TOOL_NAMES.has(toolName);

const isDisabledInputTokenLimit = (value: string): boolean => {
    const normalized = value.trim().toLowerCase();
    return normalized === '0'
        || normalized === 'false'
        || normalized === 'no'
        || normalized === 'off';
};

export const resolveMastraInputTokenLimit = (
    env: NodeJS.ProcessEnv = process.env,
): number | null => {
    const configured = toNonEmptyString(env[AGENT_SIDECAR_INPUT_TOKEN_LIMIT_ENV]);
    if (!configured) {
        return DEFAULT_MASTRA_INPUT_TOKEN_LIMIT;
    }

    if (isDisabledInputTokenLimit(configured)) {
        return null;
    }

    const parsed = Number(configured);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
        return Math.max(MIN_MASTRA_INPUT_TOKEN_LIMIT, parsed);
    }

    console.warn(
        `[agent-sidecar] ${AGENT_SIDECAR_INPUT_TOKEN_LIMIT_ENV}="${configured}" is not a positive integer; ` +
        `falling back to ${DEFAULT_MASTRA_INPUT_TOKEN_LIMIT}.`,
    );
    return DEFAULT_MASTRA_INPUT_TOKEN_LIMIT;
};

export const createMastraAgentInputProcessors = (
    options: { env?: NodeJS.ProcessEnv | undefined } = {},
): InputProcessorOrWorkflow[] => {
    const tokenLimit = resolveMastraInputTokenLimit(options.env);
    return [
        new UnicodeNormalizer({
            stripControlChars: true,
            preserveEmojis: true,
            collapseWhitespace: false,
            trim: false,
        }),
        ...(tokenLimit ? [new TokenLimiterProcessor({
            limit: tokenLimit,
            // Zed-style compaction keeps a coherent suffix of recent context.
            // Mastra's official TokenLimiterProcessor should do the same here:
            // avoid best-fit gaps that can separate a tool result from the user
            // or assistant message that made it meaningful.
            trimMode: 'contiguous',
        })] : []),
    ];
};

// 流式聊天 / Agent 的最终回答必须逐 token 实时下发。
// 此前输出侧挂了基于大模型的 PIIDetector（strategy:'redact' + lastMessageOnly），
// 它必须拿到完整最终消息才能脱敏，会把整段输出缓冲到流结束才一次性放出；
// 随后改用的 BatchPartsProcessor 虽不等待整段消息，但仍在 output 侧成批合并 token
//（batchSize 个一批），快速模型下整段答案会在很短时间内堆满批次、集中到末尾放出，
// 依旧表现为“先冒一点点、末尾哗一下全弹”。
// 由于 consumeTextStream 读取的是 output processor 之后的 fullStream，任何 output 侧
// 处理器都会截留 token。为保证真正逐 token 实时流式，输出侧不再挂任何处理器；
// 平滑节奏完全交由前端 markstream-vue 的 smoothStreaming 负责。
// 输入侧脱敏仍由 Rust 网关 collect_messages 中的 redact_text 完成，安全护栏不受影响。
export const createMastraAgentOutputProcessors = (): OutputProcessorOrWorkflow[] => [];

export const createMastraObservability = (): Observability => new Observability({
    configs: {
        default: {
            serviceName: 'agent-sidecar',
            exporters: [
                new MastraStorageExporter({
                    maxBatchSize: 20,
                    maxBufferSize: 500,
                    maxBatchWaitMs: 1_000,
                    maxRetries: 2,
                    retryDelayMs: 500,
                    strategy: 'auto',
                }),
            ],
            spanOutputProcessors: [new SensitiveDataFilter()],
        },
    },
});

// 解析全局技能目录：优先 CALAMEX_SKILLS_DIR 环境变量，其次回退到
// %APPDATA%/.calamex/skills（与 Rust 侧 storage_paths::roaming_root 保持一致）。
export const resolveGlobalSkillsDirectory = (): string | null => {
    const explicit = toNonEmptyString(process.env.CALAMEX_SKILLS_DIR);
    if (explicit) {
        return explicit;
    }
    const roamingBase = toNonEmptyString(process.env.APPDATA)
        ?? toNonEmptyString(process.env.HOME)
        ?? homedir();
    if (!roamingBase) {
        return null;
    }
    return join(roamingBase, '.calamex', 'skills');
};

// 确保全局技能目录存在并返回其绝对路径（最佳努力；失败则返回 null，降级为不自动加载技能）。
// 该目录改由 LocalFilesystem.allowedPaths 放行，无需再在受限工作区内创建 .calamex-skills 符号链接。
export const ensureGlobalSkillsDirectory = (): string | null => {
    const globalSkillsDir = resolveGlobalSkillsDirectory();
    if (!globalSkillsDir) {
        return null;
    }
    try {
        mkdirSync(globalSkillsDir, { recursive: true });
    } catch {
        return null;
    }
    return globalSkillsDir;
};

// 解析 sidecar 自身所在的包根目录（其 node_modules 内含 typescript-language-server 与
// typescript）。返回值用作 LSP 的 searchPaths：当用户打开的工作区自身未安装这些 language
// server 时，LSP 仍可回退到 sidecar 自带的实现（searchPaths 排在项目根 + cwd 之后，纯增量、
// 只增不减，对任意工作区布局都安全）。最佳努力，解析失败返回 []，此时省略 searchPaths。
const resolveBundledLspSearchPaths = (): string[] => {
    try {
        let current = dirname(fileURLToPath(import.meta.url));
        const filesystemRoot = parse(current).root;
        while (true) {
            if (existsSync(join(current, 'node_modules', 'typescript-language-server'))) {
                return [current];
            }
            if (current === filesystemRoot) {
                break;
            }
            const parent = dirname(current);
            if (parent === current) {
                break;
            }
            current = parent;
        }
    } catch {
        // 忽略：解析失败时回退到 LSP 默认查找（项目根 + process.cwd()）。
    }
    return [];
};

export const createMastraWorkspace = async (
    workspaceRootPath?: string,
    profile: TMastraToolProfile = 'write',
): Promise<AnyWorkspace | undefined> => {
    const workspaceDirectory = resolveWorkspaceDirectory(workspaceRootPath);

    if (!workspaceDirectory) {
        return undefined;
    }

    // 全局技能目录：用 allowedPaths 放行到工作区外，取代此前的 .calamex-skills 符号链接桥接；
    // 失败则降级为不自动加载技能，不阻断工作区创建。
    const globalSkillsDir = ensureGlobalSkillsDirectory();

    // 预解析 LSP 兜底搜索路径（指向 sidecar 自带的 typescript-language-server / typescript），
    // 供「打开任意文件夹」且该文件夹未本地安装 language server 时回退使用。
    const lspSearchPaths = resolveBundledLspSearchPaths();

    const filesystem = new LocalFilesystem({
        basePath: workspaceDirectory,
        contained: true,
        readOnly: profile === 'readonly',
        // contained 仍开启（防路径穿越 / 防符号链接逃逸），仅通过 allowedPaths 精确放行全局技能目录，
        // 使 Mastra skills 能解析到工作区外的该目录，同时不牺牲容器化安全约束。
        ...(globalSkillsDir ? { allowedPaths: [globalSkillsDir] } : {}),
    });

    const workspace = new Workspace({
        filesystem,
        sandbox: createHostLocalSandbox({
            workingDirectory: workspaceDirectory,
            env: createHostCommandEnv(),
        }),
        ...(globalSkillsDir ? { skills: [globalSkillsDir] } : {}),
        // 开启 LSP 语义检查：在 read_file / grep 之外补充 hover / 定义 / 实现，并在
        // write_file / edit_file / ast_edit 之后自动回灸行级诊断。内置支持 TS/JS/Python/Go/Rust；
        // 缺失对应 language server 时仅该语言无结果，不影响工作区初始化。
        // - searchPaths 指向 sidecar 自身包根，使「打开任意文件夹」时仍能解析到自带的
        //   typescript-language-server / typescript（排在项目根 + cwd 之后，纯增量、只增不减）；
        // - initTimeout 放宽到 30s，给大型仓库 TS server 冷启动留足时间，避免首个文件误判为无诊断。
        lsp: {
            initTimeout: 30_000,
            ...(lspSearchPaths.length > 0 ? { searchPaths: lspSearchPaths } : {}),
        },
        // 开启 BM25 关键字检索（search / index 工具）：纯关键字、无需 embedder / vectorStore。
        // 刻意不用 autoIndexPaths：它无法排除目录、也不读 .gitignore，递归会 walk 进嵌套的
        // node_modules / target 撑爆启动耗时与内存。改为 init() 后由 warmWorkspaceSearchIndex 在后台
        // 预热——自带目录层 denylist 剪枝（含嵌套），跳过依赖 / 构建产物，对任意工作区布局都安全。
        // tokenize.tokenizer 注入 CJK 感知分词（重叠二元组 + 西文管线），让中文注释 / 文档可被检索；
        // 语义 / 混合检索如需另配 vectorStore + embedder。
        bm25: {
            tokenize: createWorkspaceBm25TokenizeOptions(),
        },
        tools: {
            // 直接复用 Mastra 内置 read_file：已原生支持文本行区间（offset/limit）、cat -n 行号
            //（showLineNumbers 默认 true）、把图片/PDF 作为 media part 直接给模型查看、二进制安全
            //（超限仅返回元数据，不灌 base64）。这些正是其相对手写实现的长处，只按需增强媒体识别。
            [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
                enabled: true,
                // 取主流模型普遍支持的安全交集；不放开为 image/*，官方文档提示
                // 部分模型会对 SVG/BMP/HEIC 等格式失败。
                mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
                // 内联媒体上限提升到 20 MiB，超限文件回退为仅元数据，避免 base64 撑爆上下文。
                maxMediaBytes: 20 * 1024 * 1024,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
                enabled: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: {
                enabled: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
                enabled: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
                enabled: profile === 'write',
                requireApproval: createWorkspaceSensitivePathApprovalGate('workspace.write_file', true),
                requireReadBeforeWrite: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
                enabled: profile === 'write',
                requireApproval: createWorkspaceSensitivePathApprovalGate('workspace.edit_file', true),
                requireReadBeforeWrite: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: {
                enabled: profile === 'write',
                requireApproval: createWorkspaceSensitivePathApprovalGate('workspace.edit_file', true),
                requireReadBeforeWrite: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
                enabled: profile === 'write',
                requireApproval: createWorkspaceSensitivePathApprovalGate('workspace.delete', true),
            },
            [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: {
                enabled: profile === 'write',
                requireApproval: createWorkspaceSensitivePathApprovalGate('workspace.mkdir', true),
            },
            [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
                enabled: profile === 'write',
                requireApproval: true,
                // 默认 2000 token 易截断构建 / 测试 / 类型检查输出；放宽到 5000，仍保留尾部截断护栏。
                maxOutputTokens: 5000,
            },
            [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: {
                enabled: profile === 'write',
            },
            [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
                enabled: profile === 'write',
                requireApproval: true,
            },
            [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
                // 只读语义检查，对所有 profile 开放（含 readonly）。
                enabled: true,
            },
            [WORKSPACE_TOOLS.SEARCH.SEARCH]: {
                // BM25 检索：只读查询，对所有 profile 开放。
                enabled: true,
            },
            [WORKSPACE_TOOLS.SEARCH.INDEX]: {
                // 建索引需要写能力，只在可写工作区暴露；readonly 文件系统下 Mastra 会自动排除。
                enabled: profile === 'write',
            },
        },
    });

    await workspace.init();

    // 启动后台预热 BM25 索引：非阻塞（不 await），不拖慢工作区就绪。
    // warmWorkspaceSearchIndex 内部在目录层剪枝掉 node_modules / target / dist 等（含嵌套），
    // 且自吞所有错误（best-effort），不会影响工作区可用性。
    void warmWorkspaceSearchIndex(workspace).catch(() => undefined);

    return workspace;
};

export const destroyMastraWorkspace = async (workspace: AnyWorkspace | undefined): Promise<void> => {
    if (!workspace || workspace.status === 'destroyed') {
        return;
    }

    await workspace.destroy().catch(() => undefined);
};

export const createMastraBrowser = (): MastraBrowser => new AgentBrowser({
    headless: true,
});

export const destroyMastraBrowser = async (browser: MastraBrowser | undefined): Promise<void> => {
    if (!browser || browser.status === 'closed') {
        return;
    }

    await browser.close().catch(() => undefined);
};

export const allowWorkspaceWriteAfterVerifiedRead = async (
    workspace: AnyWorkspace | undefined,
    path: string | undefined,
): Promise<void> => {
    if (!workspace || !path) {
        return;
    }

    const filesystem = workspace.filesystem;
    const originalToolsConfig = workspace.getToolsConfig();
    if (!filesystem) {
        return;
    }

    const statAtApproval = await filesystem.stat(path);
    await filesystem.readFile(path, { encoding: 'utf-8' });

    const toolConfig = originalToolsConfig?.[WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE];
    const writeFileConfig = toolConfig && typeof toolConfig === 'object'
        ? toolConfig
        : {};
    const relaxedToolsConfig: WorkspaceToolsConfig = {
        ...originalToolsConfig,
        [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
            ...writeFileConfig,
            requireReadBeforeWrite: async ({ args }): Promise<boolean> => {
                const requestedPath = typeof args === 'object' && args !== null && 'path' in args
                    ? args.path
                    : undefined;
                if (requestedPath !== path) {
                    return true;
                }

                const currentStat = await filesystem.stat(path);
                return currentStat.modifiedAt.getTime() !== statAtApproval.modifiedAt.getTime();
            },
        },
    };

    workspace.setToolsConfig(relaxedToolsConfig);
};

export const createMastraToolLoadPlan = (
    input: Pick<IAgentRuntimeInput, 'goal' | 'messages' | 'mode' | 'planId' | 'planStepId'>,
    workspaceRootPath: string | undefined,
    contextReferences: readonly IAgentContextReferenceInput[] = [],
): IMastraToolLoadPlan => {
    if (input.mode === 'ask') {
        void workspaceRootPath;
        void contextReferences;

        return {
            workspaceEnabled: false,
            browserEnabled: false,
            strategy: 'none',
        };
    }

    const workspaceAvailable = resolveWorkspaceDirectory(workspaceRootPath) !== null;
    void input;
    void contextReferences;

    return {
        workspaceEnabled: workspaceAvailable,
        browserEnabled: false,
        strategy: workspaceAvailable ? 'gateway+workspace' : 'gateway',
    };
};

export const createMastraTextModeExecutionPlan = (
    input: Pick<IAgentRuntimeInput, 'mode' | 'threadId'>,
): IMastraTextModeExecutionPlan => {
    if (input.mode === 'ask' && toNonEmptyString(input.threadId ?? null) === null) {
        return {
            useTools: false,
            useMemory: false,
        };
    }

    return {
        useTools: true,
        useMemory: true,
    };
};
