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
import type { IAgentContextReferenceInput, IAgentRuntimeInput } from '../contracts/runtime-input.js';
import type { IMastraTextModeExecutionPlan, IMastraToolLoadPlan, TMastraToolProfile } from '../shared/types.js';
import { MASTRA_WORKSPACE_REDACTED_PREVIEW_TOOL_NAMES, WINDOWS_POWERSHELL_CORE_RELATIVE_PATH, WINDOWS_POWERSHELL_RELATIVE_PATH } from '../shared/types.js';
import { toNonEmptyString } from '../shared/utils.js';
import { isFalsyEnv } from '../shared/env-utils.js';
import { normalizeNewlines } from '../shared/normalize-newlines.js';
import { resolveWorkspaceDirectory } from '../context/context.js';
import { decideSensitivePathToolPermission, type IToolPermissionPolicy } from '../policy/tool-permission-policy.js';
import { warmWorkspaceSearchIndex } from './search-index.js';

export const isWindowsRuntime = (): boolean => process.platform === 'win32';

export const BUILTIN_AGENT_INPUT_TOKEN_LIMIT_ENV = 'BUILTIN_AGENT_INPUT_TOKEN_LIMIT';
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

export const normalizeNewlines = (value: string): string =>
    value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');

export const decodeUtf8CommandChunk = (
    decoder: TextDecoder,
    chunk?: Buffer,
): string => normalizeNewlines(decoder.decode(chunk, { stream: Boolean(chunk) }));

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
            const message = normalizeNewlines(error.message);
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



export const resolveMastraInputTokenLimit = (
    env: NodeJS.ProcessEnv = process.env,
): number | null => {
    const configured = toNonEmptyString(env[BUILTIN_AGENT_INPUT_TOKEN_LIMIT_ENV]);
    if (!configured) {
        return DEFAULT_MASTRA_INPUT_TOKEN_LIMIT;
    }

    if (isFalsyEnv(configured)) {
        return null;
    }

    const parsed = Number(configured);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
        return Math.max(MIN_MASTRA_INPUT_TOKEN_LIMIT, parsed);
    }

    console.warn(
        `[builtin-agent] ${BUILTIN_AGENT_INPUT_TOKEN_LIMIT_ENV}="${configured}" is not a positive integer; ` +
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
            serviceName: 'builtin-agent',
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
        // BM25 关键字检索：@mastra/core 1.41 的 WorkspaceConfig.bm25 仅接受 boolean | { k1, b }，
        // 不再转发自定义 tokenize（见 mastra issue #17636），即便传入也会在运行时被忽略。
        // 故改用 bm25: true 启用内置分词；CJK 感知分词器（bm25-tokenizer.ts）暂留待 Mastra 支持后再接回。
        bm25: true,
        tools: {
            // 直接复用 Mastra 内置 read_file：已原生支持文本行区间（offset/limit）、cat -n 行号
            //（showLineNumbers 输入参数默认 true，在 schema 层，非配置项）、把图片/PDF 作为 media part 直接给模型查看、
            // 二进制安全（超限仅返回元数据，不灸 base64）。这些正是其相对手写实现的长处，只按需增强媒体识别。
            [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
                enabled: true,
                // 取主流模型普遍支持的安全交集；不放开为 image/*，官方文档提示
                // 部分模型会对 SVG/BMP/HEIC 等格式失败。
                mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
                // 内联媒体上限提升到 20 MiB，超限文件回退为仅元数据，避免 base64 撑爆上下文。
                maxMediaBytes: 20 * 1024 * 1024,
                // 官方 maxOutputTokens 默认仅 3000，读中等以上文件会被截断。作为主读取工具提到 16000，
                // 兼顾“完整读取体验”与上下文预算；超过仍可用 offset/limit 继续分页。
                maxOutputTokens: 16000,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]: {
                enabled: true,
                // 大目录列举默认 3000 token 易截断，放宽到 8000。
                maxOutputTokens: 8000,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.FILE_STAT]: {
                enabled: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.GREP]: {
                enabled: true,
                // 全仓匹配命中多，默认 3000 token 易截断，放宽到 8000。
                maxOutputTokens: 8000,
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
                // 后台进程日志可能很长，默认 3000 token 易截断，放宽到 8000。
                maxOutputTokens: 8000,
            },
            [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
                enabled: profile === 'write',
                requireApproval: true,
            },
            [WORKSPACE_TOOLS.LSP.LSP_INSPECT]: {
                // 只读语义检查，对所有 profile 开放（含 readonly）。
                enabled: true,
                // hover / 定义 / 引用 / 诊断聚合输出可能较长，放宽到 8000。
                maxOutputTokens: 8000,
            },
            [WORKSPACE_TOOLS.SEARCH.SEARCH]: {
                // BM25 检索：只读查询，对所有 profile 开放。
                enabled: true,
                // 排名结果列表可能较长，默认 3000 token 易截断，放宽到 8000。
                maxOutputTokens: 8000,
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

// 内置浏览器 CDP 端口：与前端 AGENT_WEBVIEW_CDP_PORT（src/services/ipc/agent-webview.service.ts）
// 及 Rust 侧 agent_webview 命令的 remote-debugging-port 保持一致。默认 9333；
// 宿主可经环境变量 CALAMEX_AGENT_WEBVIEW_CDP_PORT 注入覆盖，作为跨进程的端口兜底来源。
const AGENT_WEBVIEW_CDP_PORT =
    Number.parseInt(process.env.CALAMEX_AGENT_WEBVIEW_CDP_PORT ?? '', 10) || 9333;

// 浏览器操作默认超时（ms）。Mastra AgentBrowser 默认 30_000；放宽到 60_000，
// 让慢加载 / 网络重的页面（goto / wait 等）操作有更充裕的完成时间，强化操作鲁棒性。
const AGENT_BROWSER_OPERATION_TIMEOUT_MS = 60_000;

// 在「连接时」动态解析原生内置 webview 的 browser 级 CDP WebSocket 端点。
// 原生 webview 以 --remote-debugging-port 暴露 CDP，其 ws 端点形如
// ws://127.0.0.1:<port>/devtools/browser/<uuid>，<uuid> 运行时动态生成、无法硬编码，
// 故经 /json/version 在连接时解析。预览面板未打开时此处抛错，仅影响该次浏览器工具调用，
// 不影响 Agent 的其余能力——cdpUrl 的函数形态正是为这种惰性解析设计。
const resolveAgentWebviewCdpWebSocketUrl = async (): Promise<string> => {
    const endpoint = `http://127.0.0.1:${AGENT_WEBVIEW_CDP_PORT}/json/version`;
    const response = await fetch(endpoint);
    if (!response.ok) {
        throw new Error(
            `内置浏览器 CDP 端点不可用（HTTP ${response.status}）：请先在侧边栏打开网页预览面板，再让 AI 操作内置浏览器。`,
        );
    }
    const info = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    const wsUrl = typeof info.webSocketDebuggerUrl === 'string' ? info.webSocketDebuggerUrl : '';
    if (!wsUrl) {
        throw new Error('内置浏览器 CDP 端点未返回 webSocketDebuggerUrl，无法连接内置浏览器。');
    }
    return wsUrl;
};

// 经 CDP 连接到「用户可见的原生内置 webview」（由 src-tauri 的 agent_webview 命令以
// remote-debugging-port 暴露），让 AI 直接操作侧边栏里的内置浏览器，而非另起一个不可见的
// 无头 Chromium。cdpUrl 用函数形态：连接时动态解析 browser 级 ws 端点（端口固定、uuid 动态）。
// 提供 cdpUrl 后 scope 自动回退为 'shared'（无法再 spawn 新实例），无需手写 scope；不传 headless（连接既有浏览器时无意义）。
//
// 操作能力拉满（用户要求「尽量开启、加强操作能力」）：
// - excludeTools 显式置空数组 → 16 个浏览器工具全部启用：browser_goto / snapshot / click /
//   type / press / select / scroll / screenshot / close / hover / back / dialog / wait /
//   tabs / drag / evaluate（含 JS 执行的逃生舱），不裁剪任何一个；
// - timeout 放宽到 AGENT_BROWSER_OPERATION_TIMEOUT_MS（60s，默认仅 30s），慢页面操作不易过早超时；
// - 刻意「不」设 viewport：本浏览器连接的是用户可见的原生侧栏 webview，设 viewport 会触发
//   设备度量覆盖、强行缩放可见内容（与面板真实尺寸打架，重演拖拽缩放类问题）；保持不设，
//   让其沿用原生 webview 的真实尺寸，截图与所见一致。
export const createMastraBrowser = (): MastraBrowser => new AgentBrowser({
    cdpUrl: resolveAgentWebviewCdpWebSocketUrl,
    timeout: AGENT_BROWSER_OPERATION_TIMEOUT_MS,
    excludeTools: [],
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

    // Agent 模式默认开启内置浏览器：经 CDP 连接用户可见的原生 webview（见 createMastraBrowser）。
    // 真正的连接惰性发生在首次浏览器工具调用，预览面板未打开时仅该工具报错，不影响其余能力。
    const browserEnabled = true;

    return {
        workspaceEnabled: workspaceAvailable,
        browserEnabled,
        strategy: [
            'gateway',
            ...(workspaceAvailable ? ['workspace'] : []),
            'browser',
        ].join('+'),
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
