import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentBrowser } from '@mastra/agent-browser';
import type { MastraBrowser } from '@mastra/core/browser';
import { UnicodeNormalizer, type InputProcessorOrWorkflow, type OutputProcessorOrWorkflow } from '@mastra/core/processors';
import { LocalFilesystem, LocalSandbox, Workspace, WORKSPACE_TOOLS, type AnyWorkspace, type CommandResult, type ExecuteCommandOptions, type WorkspaceToolsConfig } from '@mastra/core/workspace';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import type { IAgentContextReferenceInput, IAgentRuntimeInput } from './contracts/runtime-input.js';
import type { IMastraTextModeExecutionPlan, IMastraToolLoadPlan, TMastraToolProfile } from './types.js';
import { MASTRA_WORKSPACE_REDACTED_PREVIEW_TOOL_NAMES, WINDOWS_POWERSHELL_CORE_RELATIVE_PATH, WINDOWS_POWERSHELL_RELATIVE_PATH } from './types.js';
import { toNonEmptyString } from './utils.js';
import { resolveWorkspaceDirectory } from './context/context.js';

export const isWindowsRuntime = (): boolean => process.platform === 'win32';

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

export const createMastraAgentInputProcessors = (): InputProcessorOrWorkflow[] => [
    new UnicodeNormalizer({
        stripControlChars: true,
        preserveEmojis: true,
        collapseWhitespace: false,
        trim: false,
    }),
];

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

/// 桥接进工作区的全局技能目录链接名。
const BRIDGED_SKILLS_DIR_NAME = '.calamex-skills';

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

// 把全局技能目录桥接进受限工作区内，使 Mastra 的 skills 能在 contained
// 文件系统内解析到。返回用于 Workspace.skills 的相对路径，失败则返回 null
//（降级为不自动加载，不阻断工作区创建）。
export const bridgeSkillsIntoWorkspace = (workspaceDirectory: string): string | null => {
    const globalSkillsDir = resolveGlobalSkillsDirectory();
    if (!globalSkillsDir) {
        return null;
    }
    try {
        mkdirSync(globalSkillsDir, { recursive: true });
    } catch {
        return null;
    }

    const linkPath = join(workspaceDirectory, BRIDGED_SKILLS_DIR_NAME);
    try {
        if (existsSync(linkPath)) {
            // 已存在（可能是上一轮创建的链接）：直接复用。
            return `./${BRIDGED_SKILLS_DIR_NAME}`;
        }
        symlinkSync(globalSkillsDir, linkPath, isWindowsRuntime() ? 'junction' : 'dir');
        return `./${BRIDGED_SKILLS_DIR_NAME}`;
    } catch {
        return null;
    }
};

export const createMastraWorkspace = async (
    workspaceRootPath?: string,
    profile: TMastraToolProfile = 'write',
): Promise<AnyWorkspace | undefined> => {
    const workspaceDirectory = resolveWorkspaceDirectory(workspaceRootPath);

    if (!workspaceDirectory) {
        return undefined;
    }

    // 尽力桥接全局技能库；成功时交给 Mastra 自动索引 / 加载，失败则静默跳过。
    const bridgedSkillsPath = bridgeSkillsIntoWorkspace(workspaceDirectory);

    const workspace = new Workspace({
        filesystem: new LocalFilesystem({
            basePath: workspaceDirectory,
            contained: true,
            readOnly: profile === 'readonly',
        }),
        sandbox: createHostLocalSandbox({
            workingDirectory: workspaceDirectory,
            env: createHostCommandEnv(),
        }),
        ...(bridgedSkillsPath ? { skills: [bridgedSkillsPath] } : {}),
        tools: {
            [WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]: {
                enabled: true,
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
                requireApproval: true,
                requireReadBeforeWrite: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
                enabled: profile === 'write',
                requireApproval: true,
                requireReadBeforeWrite: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.AST_EDIT]: {
                enabled: profile === 'write',
                requireApproval: true,
                requireReadBeforeWrite: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
                enabled: profile === 'write',
                requireApproval: true,
            },
            [WORKSPACE_TOOLS.FILESYSTEM.MKDIR]: {
                enabled: profile === 'write',
                requireApproval: true,
            },
            [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
                enabled: profile === 'write',
                requireApproval: true,
            },
            [WORKSPACE_TOOLS.SANDBOX.GET_PROCESS_OUTPUT]: {
                enabled: profile === 'write',
            },
            [WORKSPACE_TOOLS.SANDBOX.KILL_PROCESS]: {
                enabled: profile === 'write',
                requireApproval: true,
            },
        },
    });

    await workspace.init();
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
