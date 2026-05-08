/**
 * AED · Workflow 文案模板库 v1.0
 * 纯静态模板,不依赖 LLM。
 * 输入结构化参数 → 输出 TaskBlock[]
 */

import {
    classifyRuntimeToolKind,
    normalizeRuntimeToolName,
    type TAiRuntimeToolKind,
} from '@/constants/ai-runtime-tools'
import type { IAiToolCall } from '@/types/ai'
import type { IFileIconAsset, TFileIconEntryKind } from '@/types/file-icon'
import {
    formatElapsed as formatToolElapsed,
    normalizeText as normalizePreviewText,
    parseTarget,
    stripTargetNoise,
} from '@/utils/agent-activity-inline-formatters'
import { resolveFileIconAsset, resolveFileIconKey } from '@/utils/file-icons'
import { getPathBaseName } from '@/utils/path'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'error'

export type IconKey =
    | 'vue'
    | 'typescript'
    | 'javascript'
    | 'rust'
    | 'css'
    | 'html'
    | 'json'
    | 'markdown'

export interface FileMeta {
    name: string
    icon: IconKey
    color?: string
    path?: string
    kind?: TFileIconEntryKind
    themeIconKey?: string
    iconAsset?: IFileIconAsset
}

export type TaskItemData =
    | { type: 'text'; text: string }
    | { type: 'file'; text: string; file: FileMeta }

export interface TaskBlock {
    title: string
    status: TaskStatus
    items: TaskItemData[]
}

export interface PipelineState {
    phase: 1 | 2 | 3
    cur?: number
    total?: number
    error?: { code: string; msg: string; failedIndex?: number }
}

const fmt = {
    num: (n: number) => n.toLocaleString('en-US'),
    ms2s: (ms: number) => (ms / 1000).toFixed(1) + ' s',
    pct: (n: number) => (n * 100).toFixed(1) + '%',
}

function t(text: string): TaskItemData {
    return { type: 'text', text }
}

function f(text: string, file: FileMeta): TaskItemData {
    return { type: 'file', text, file }
}

function statusOf(taskIdx: 1 | 2 | 3, s: PipelineState): TaskStatus {
    if (s.error && s.phase === taskIdx) return 'error'
    if (s.phase > taskIdx) return 'completed'
    if (s.phase === taskIdx) return 'in_progress'
    return 'pending'
}

export interface PlanInput {
    intent: string
    entityCount?: number
    totalFiles?: number
    matchedCount?: number
    filesRead?: FileMeta[]
    planSteps?: number
    estimatedLines?: number
    state: PipelineState
    scanned?: number
    timeoutS?: number
}

export function buildPlanTasks(i: PlanInput): TaskBlock[] {
    const s1 = statusOf(1, i.state)
    const s2 = statusOf(2, i.state)
    const s3 = statusOf(3, i.state)

    return [
        {
            title: '理解需求',
            status: s1,
            items:
                s1 === 'completed'
                    ? [
                        t(`解析用户意图:「${i.intent}」`),
                        t(`识别出 ${i.entityCount ?? 0} 个目标实体`),
                    ]
                    : s1 === 'in_progress'
                        ? [t('正在解析用户意图……')]
                        : s1 === 'error'
                            ? [t(`意图识别失败:${i.state.error?.msg ?? '上下文不足'}`)]
                            : [t('待解析用户意图')],
        },
        {
            title: '检索上下文',
            status: s2,
            items:
                s2 === 'completed'
                    ? [
                        t(`扫描 ${fmt.num(i.totalFiles ?? 0)} 个文件,命中 ${i.matchedCount ?? 0} 处相关`),
                        ...(i.filesRead ?? []).map((file) => f('读取 ', file)),
                    ]
                    : s2 === 'in_progress'
                        ? [
                            t(
                                `正在检索相关文件…… 已扫描 ${fmt.num(i.scanned ?? 0)} / ${fmt.num(i.totalFiles ?? 0)}`,
                            ),
                        ]
                        : s2 === 'error'
                            ? [t(`检索超时(>${i.timeoutS ?? 30} s),已使用降级缓存`)]
                            : [t('待检索相关文件')],
        },
        {
            title: '产出执行计划',
            status: s3,
            items:
                s3 === 'completed'
                    ? [
                        t(`生成 ${i.planSteps ?? 0} 步计划,预估改动 ~${i.estimatedLines ?? 0} 行`),
                        t('等待用户确认'),
                    ]
                    : s3 === 'in_progress'
                        ? [t('正在汇总改动方案……')]
                        : s3 === 'error'
                            ? [t(`计划生成失败:${i.state.error?.msg ?? ''}`)]
                            : [t('待生成执行计划')],
        },
    ]
}

export interface EditInput {
    hash?: string
    snapshot?: string
    files?: FileMeta[]
    current?: FileMeta
    added?: number
    removed?: number
    rollbackToken?: string
    state: PipelineState
    whitelistPath?: string
}

export function buildEditTasks(i: EditInput): TaskBlock[] {
    const s1 = statusOf(1, i.state)
    const s2 = statusOf(2, i.state)
    const s3 = statusOf(3, i.state)
    const total = i.files?.length ?? i.state.total ?? 0
    const cur = i.state.cur ?? 0

    return [
        {
            title: '预检查',
            status: s1,
            items:
                s1 === 'completed'
                    ? [
                        t('校验 workspace 边界:通过'),
                        t(`计算基线哈希 \`${i.hash ?? '----'}\``),
                        t(`创建快照 \`${i.snapshot ?? '----'}\``),
                    ]
                    : s1 === 'in_progress'
                        ? [t('正在创建快照……')]
                        : s1 === 'error'
                            ? [t(`写权限不足:${i.whitelistPath ?? '路径未声明'} 不在白名单`)]
                            : [t('待校验 workspace 边界')],
        },
        {
            title: '流式写入',
            status: s2,
            items:
                s2 === 'completed'
                    ? [t(`写入 ${total} / ${total} 个文件,全部哈希一致`)]
                    : s2 === 'in_progress'
                        ? [
                            t(`正在写入第 ${cur} / ${total} 个文件`),
                            ...(i.current ? [f('写入 ', i.current)] : []),
                        ]
                        : s2 === 'error'
                            ? [
                                t(
                                    `第 ${i.state.error?.failedIndex ?? '?'} 个文件写入失败(\`${i.state.error?.code ?? 'AI_EDIT_UNKNOWN'}\`)`,
                                ),
                                t(`已自动回退至 \`${i.snapshot ?? '----'}\``),
                            ]
                            : [t('待写入文件')],
        },
        {
            title: '后置校验',
            status: s3,
            items:
                s3 === 'completed'
                    ? [
                        t(`Diff: +${i.added ?? 0} / −${i.removed ?? 0}`),
                        t(`回滚 token:\`${i.rollbackToken ?? '----'}\``),
                    ]
                    : s3 === 'in_progress'
                        ? [t('正在生成 diff……')]
                        : s3 === 'error'
                            ? [t(`校验失败:${i.state.error?.msg ?? '编译报错'}`)]
                            : [t('待生成 diff')],
        },
    ]
}

export interface BugFixInput {
    targetFile?: FileMeta
    line?: number
    rootCause?: string
    fixSummary?: string
    extraGuard?: string
    testTotal?: number
    testCur?: number
    failedCase?: string
    durationMs?: number
    state: PipelineState
}

export function buildBugFixTasks(i: BugFixInput): TaskBlock[] {
    const s1 = statusOf(1, i.state)
    const s2 = statusOf(2, i.state)
    const s3 = statusOf(3, i.state)

    return [
        {
            title: '复现与定位',
            status: s1,
            items:
                s1 === 'completed'
                    ? [
                        ...(i.targetFile
                            ? [f('解析报错堆栈,定位到 ', i.targetFile)]
                            : [t('解析报错堆栈')]),
                        ...(i.line ? [t(`第 ${i.line} 行`)] : []),
                        t(`推断根因:${i.rootCause ?? '未知'}`),
                    ]
                    : s1 === 'in_progress'
                        ? [t('正在分析堆栈……')]
                        : s1 === 'error'
                            ? [t('堆栈不完整,无法定位')]
                            : [t('待分析报错')],
        },
        {
            title: '修复',
            status: s2,
            items:
                s2 === 'completed'
                    ? [
                        t(i.fixSummary ?? '已应用修复'),
                        ...(i.extraGuard ? [t(`新增 ${i.extraGuard}`)] : []),
                    ]
                    : s2 === 'in_progress'
                        ? (i.targetFile ? [f('正在改写 ', i.targetFile)] : [t('正在应用修复……')])
                        : s2 === 'error'
                            ? [t('修复方案与现有代码冲突,已暂停')]
                            : [t('待应用修复')],
        },
        {
            title: '回归验证',
            status: s3,
            items:
                s3 === 'completed'
                    ? [
                        t(`运行 ${i.testTotal ?? 0} 个测试用例,全部通过`),
                        ...(i.durationMs ? [t(`耗时 ${fmt.ms2s(i.durationMs)}`)] : []),
                    ]
                    : s3 === 'in_progress'
                        ? [t(`正在运行测试 ${i.testCur ?? 0} / ${i.testTotal ?? 0}`)]
                        : s3 === 'error'
                            ? [t(`测试失败:${i.failedCase ?? '未指定'}`)]
                            : [t('待运行测试')],
        },
    ]
}

export interface TestInput {
    total?: number
    unit?: number
    e2e?: number
    cur?: number
    failed?: number
    skipped?: number
    durationMs?: number
    coverage?: number
    reportFile?: FileMeta
    configFile?: string
    state: PipelineState
}

export function buildTestTasks(i: TestInput): TaskBlock[] {
    const s1 = statusOf(1, i.state)
    const s2 = statusOf(2, i.state)
    const s3 = statusOf(3, i.state)

    return [
        {
            title: '加载用例',
            status: s1,
            items:
                s1 === 'completed'
                    ? [t(`收集 ${i.total ?? 0} 个测试用例(unit ${i.unit ?? 0} + e2e ${i.e2e ?? 0})`)]
                    : s1 === 'in_progress'
                        ? [t('正在加载测试用例……')]
                        : s1 === 'error'
                            ? [t(`测试入口缺失:未找到 \`${i.configFile ?? 'vitest.config.ts'}\``)]
                            : [t('待加载用例')],
        },
        {
            title: '执行',
            status: s2,
            items:
                s2 === 'completed'
                    ? [t(`全部通过,耗时 ${fmt.ms2s(i.durationMs ?? 0)}`)]
                    : s2 === 'in_progress'
                        ? [t(`进度 ${i.cur ?? 0} / ${i.total ?? 0} ｜ 失败 ${i.failed ?? 0}`)]
                        : s2 === 'error'
                            ? [t(`${i.failed ?? 0} 个用例失败 ｜ ${i.skipped ?? 0} 个未执行`)]
                            : [t('待执行测试')],
        },
        {
            title: '生成报告',
            status: s3,
            items:
                s3 === 'completed'
                    ? [
                        t(`覆盖率 ${fmt.pct(i.coverage ?? 0)}`),
                        ...(i.reportFile ? [f('输出 ', i.reportFile)] : []),
                    ]
                    : s3 === 'in_progress'
                        ? [t('正在生成覆盖率报告……')]
                        : s3 === 'error'
                            ? [t('覆盖率工具崩溃,无报告')]
                            : [t('待生成报告')],
        },
    ]
}

export interface RollbackInput {
    snapshot?: string
    fileCount?: number
    state: PipelineState
}

export function buildRollbackTasks(i: RollbackInput): TaskBlock[] {
    const s1 = statusOf(1, i.state)
    const s2 = statusOf(2, i.state)
    const s3 = statusOf(3, i.state)
    const cur = i.state.cur ?? 0
    const total = i.state.total ?? i.fileCount ?? 0

    return [
        {
            title: '定位快照',
            status: s1,
            items:
                s1 === 'completed'
                    ? [
                        t(`锁定快照 \`${i.snapshot ?? '----'}\``),
                        t(`包含 ${i.fileCount ?? 0} 个文件改动`),
                    ]
                    : s1 === 'in_progress'
                        ? [t('正在查找快照……')]
                        : s1 === 'error'
                            ? [t('快照已过期,仅可回滚到上一次')]
                            : [t('待定位快照')],
        },
        {
            title: '回放',
            status: s2,
            items:
                s2 === 'completed'
                    ? [t(`回放 ${total} 个文件 ｜ 全部哈希一致`)]
                    : s2 === 'in_progress'
                        ? [t(`正在回放第 ${cur} / ${total} 个文件`)]
                        : s2 === 'error'
                            ? [t(`第 ${i.state.error?.failedIndex ?? '?'} 个文件存在外部修改,已停止避免覆盖`)]
                            : [t('待回放文件')],
        },
        {
            title: '校验',
            status: s3,
            items:
                s3 === 'completed'
                    ? [t('工作区已恢复至快照状态 ｜ Git status 干净')]
                    : s3 === 'in_progress'
                        ? [t('正在校验工作区状态……')]
                        : s3 === 'error'
                            ? [t('工作区仍有残留改动,需手动确认')]
                            : [t('待校验工作区')],
        },
    ]
}

export type IMcpToolTaskInput = Pick<
    IAiToolCall,
    'name' | 'status' | 'summary' | 'targetPreview' | 'detailItems' | 'elapsedMs'
>

export interface ICreateFileMetaOptions {
    name?: string
    color?: string
    kind?: TFileIconEntryKind
}

interface IToolCopyDefinition {
    title: string
    running: string
    completed: string
    failed: string
    defaultTarget?: string
    preferFileChip?: boolean
    fileLead?: string
}

interface IToolCopyMatcher {
    pattern: RegExp
    definition: IToolCopyDefinition
}

const MAX_TOOL_FILE_ITEMS = 3
const MAX_TOOL_DETAIL_ITEMS = 4

const TOOL_STATUS_TO_TASK_STATUS: Readonly<Record<IAiToolCall['status'], TaskStatus>> = {
    pending: 'pending',
    running: 'in_progress',
    succeeded: 'completed',
    failed: 'error',
    denied: 'error',
}

const LEGACY_FILE_ICON_BY_EXTENSION: Readonly<Record<string, IconKey>> = {
    vue: 'vue',
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    bash: 'javascript',
    sh: 'javascript',
    zsh: 'javascript',
    rs: 'rust',
    css: 'css',
    scss: 'css',
    less: 'css',
    html: 'html',
    htm: 'html',
    json: 'json',
    jsonc: 'json',
    yaml: 'json',
    yml: 'json',
    toml: 'json',
    md: 'markdown',
    mdx: 'markdown',
}

const TOOL_SUMMARY_NOISE_PATTERNS: readonly RegExp[] = [
    /^tool call requested:/iu,
    /^tool\s+.+\s+requires inline user confirmation/iu,
    /^\w+(?:[-_]\w+)+\s+(?:completed|failed|staged|executed|created|found|requires|blocked|refused|payload)\b/iu,
]

const FILE_REFERENCE_PREFIX_PATTERN =
    /^(?:文件|路径|目标|目录|输出|输入|修改|写入|读取|暂存|范围|位置|结果|文件名|引用)\s*[：:]\s*/u

const FILE_PATH_INLINE_PATTERN =
    /(?:[a-zA-Z]:[\\/]|\.{1,2}[\\/]|@?[a-zA-Z0-9_.-]+[\\/])+[a-zA-Z0-9_.-]+(?:\.[a-zA-Z][a-zA-Z0-9]{0,11})?/gu

const FILE_NAME_INLINE_PATTERN =
    /\b[a-zA-Z0-9_.-]+\.[a-zA-Z][a-zA-Z0-9]{0,11}\b/gu

const defineToolCopy = (
    title: string,
    running: string,
    completed: string,
    failed: string,
    options: Partial<Pick<IToolCopyDefinition, 'defaultTarget' | 'preferFileChip' | 'fileLead'>> = {},
): IToolCopyDefinition => ({
    title,
    running,
    completed,
    failed,
    ...options,
})

const TOOL_COPY_MATCHERS: readonly IToolCopyMatcher[] = [
    {
        pattern: /^(?:read_current_file|read_file|read_text_file|read_project_file)$/u,
        definition: defineToolCopy('读取文件', '正在读取文件', '已读取文件', '读取文件失败', {
            defaultTarget: '文件',
            preferFileChip: true,
            fileLead: '读取 ',
        }),
    },
    {
        pattern: /^(?:read_selected_text)$/u,
        definition: defineToolCopy('读取当前选区', '正在读取当前选区', '已读取当前选区', '读取当前选区失败', {
            defaultTarget: '当前选区',
        }),
    },
    {
        pattern: /^(?:read_multiple_files|open_nodes)$/u,
        definition: defineToolCopy('批量读取文件', '正在批量读取文件', '已批量读取文件', '批量读取文件失败', {
            defaultTarget: '多份文件',
            preferFileChip: true,
            fileLead: '读取 ',
        }),
    },
    {
        pattern: /^(?:get_file_info)$/u,
        definition: defineToolCopy('读取文件信息', '正在读取文件信息', '已读取文件信息', '读取文件信息失败', {
            defaultTarget: '文件信息',
            preferFileChip: true,
            fileLead: '检查 ',
        }),
    },
    {
        pattern: /^(?:view_image)$/u,
        definition: defineToolCopy('查看图片', '正在查看图片', '已查看图片', '查看图片失败', {
            defaultTarget: '图片资源',
            preferFileChip: true,
            fileLead: '查看 ',
        }),
    },
    {
        pattern: /^(?:copilot_getnotebooksummary|run_notebook_cell|edit_notebook_file)$/u,
        definition: defineToolCopy('处理 Notebook', '正在处理 Notebook', '已处理 Notebook', '处理 Notebook 失败', {
            defaultTarget: 'Notebook',
            preferFileChip: true,
            fileLead: '处理 ',
        }),
    },
    {
        pattern: /^(?:file_search|search_files|search_project_files)$/u,
        definition: defineToolCopy('搜索项目文件', '正在搜索文件名', '已完成文件搜索', '搜索文件失败', {
            defaultTarget: '项目文件',
        }),
    },
    {
        pattern: /^(?:grep_search|search_text)$/u,
        definition: defineToolCopy('搜索项目内容', '正在搜索项目内容', '已完成内容搜索', '搜索内容失败', {
            defaultTarget: '项目内容',
        }),
    },
    {
        pattern: /^(?:semantic_search)$/u,
        definition: defineToolCopy('语义检索', '正在进行语义检索', '已完成语义检索', '语义检索失败', {
            defaultTarget: '相关代码',
        }),
    },
    {
        pattern: /^(?:search_symbols|search_project_symbols|vscode_listcodeusages)$/u,
        definition: defineToolCopy('搜索符号', '正在搜索符号', '已完成符号搜索', '搜索符号失败', {
            defaultTarget: '项目符号',
        }),
    },
    {
        pattern: /^(?:list_dir|list_workspace_entries|directory_tree|get_project_tree|list_project_files|list_allowed_directories)$/u,
        definition: defineToolCopy('读取项目结构', '正在读取项目结构', '已读取项目结构', '读取项目结构失败', {
            defaultTarget: '项目结构',
        }),
    },
    {
        pattern: /^(?:get_diagnostics|get_errors|mcp_pylance_mcp_s_pylancefilesyntaxerrors)$/u,
        definition: defineToolCopy('读取诊断信息', '正在读取诊断信息', '已读取诊断信息', '读取诊断信息失败', {
            defaultTarget: '诊断结果',
        }),
    },
    {
        pattern: /^(?:get_test_targets)$/u,
        definition: defineToolCopy('收集测试目标', '正在收集测试目标', '已收集测试目标', '收集测试目标失败', {
            defaultTarget: '测试入口',
        }),
    },
    {
        pattern: /^(?:run_test|test_failure)$/u,
        definition: defineToolCopy('运行测试', '正在运行测试', '已完成测试', '测试执行失败', {
            defaultTarget: '测试任务',
        }),
    },
    {
        pattern: /^(?:run_command|run_in_terminal|send_to_terminal|get_terminal_output|create_and_run_task)$/u,
        definition: defineToolCopy('执行命令', '正在执行命令', '已执行命令', '执行命令失败', {
            defaultTarget: '终端命令',
        }),
    },
    {
        pattern: /^(?:terminal_last_command|terminal_selection)$/u,
        definition: defineToolCopy('读取终端上下文', '正在读取终端上下文', '已读取终端上下文', '读取终端上下文失败', {
            defaultTarget: '终端状态',
        }),
    },
    {
        pattern: /^(?:web_search|fetch_webpage|tavily.*)$/u,
        definition: defineToolCopy('联网检索', '正在联网检索', '已完成联网检索', '联网检索失败', {
            defaultTarget: '搜索结果',
        }),
    },
    {
        pattern: /^(?:web_fetch|open_browser_page|navigate_page|read_page)$/u,
        definition: defineToolCopy('读取网页内容', '正在读取网页内容', '已读取网页内容', '读取网页内容失败', {
            defaultTarget: '网页',
        }),
    },
    {
        pattern: /^(?:click_element|hover_element|type_in_page|handle_dialog|drag_element)$/u,
        definition: defineToolCopy('操作浏览器页面', '正在操作浏览器页面', '已完成页面操作', '页面操作失败', {
            defaultTarget: '页面元素',
        }),
    },
    {
        pattern: /^(?:screenshot_page)$/u,
        definition: defineToolCopy('截取页面快照', '正在截取页面快照', '已截取页面快照', '截取页面快照失败', {
            defaultTarget: '页面快照',
        }),
    },
    {
        pattern: /^(?:run_playwright_code)$/u,
        definition: defineToolCopy('执行页面脚本', '正在执行页面脚本', '已执行页面脚本', '执行页面脚本失败', {
            defaultTarget: '页面脚本',
        }),
    },
    {
        pattern: /^(?:propose_patch)$/u,
        definition: defineToolCopy('生成补丁', '正在生成补丁', '已生成补丁', '生成补丁失败', {
            defaultTarget: '补丁草案',
            preferFileChip: true,
            fileLead: '修改 ',
        }),
    },
    {
        pattern: /^(?:apply_patch|auto_apply_patch|mcp_pylance_mcp_s_pylanceinvokerefactoring)$/u,
        definition: defineToolCopy('应用补丁', '正在应用补丁', '已应用补丁', '应用补丁失败', {
            defaultTarget: '工作区改动',
            preferFileChip: true,
            fileLead: '写入 ',
        }),
    },
    {
        pattern: /^(?:create_file)$/u,
        definition: defineToolCopy('创建文件', '正在创建文件', '已创建文件', '创建文件失败', {
            defaultTarget: '新文件',
            preferFileChip: true,
            fileLead: '创建 ',
        }),
    },
    {
        pattern: /^(?:create_directory)$/u,
        definition: defineToolCopy('创建目录', '正在创建目录', '已创建目录', '创建目录失败', {
            defaultTarget: '新目录',
        }),
    },
    {
        pattern: /^(?:create_new_jupyter_notebook|create_new_workspace|get_project_setup_info)$/u,
        definition: defineToolCopy('初始化工作区', '正在初始化工作区', '已初始化工作区', '初始化工作区失败', {
            defaultTarget: '工作区配置',
        }),
    },
    {
        pattern: /^(?:stage_file)$/u,
        definition: defineToolCopy('暂存改动', '正在暂存改动', '已暂存改动', '暂存改动失败', {
            defaultTarget: 'Git 暂存区',
            preferFileChip: true,
            fileLead: '暂存 ',
        }),
    },
    {
        pattern: /^(?:create_commit|git_commit)$/u,
        definition: defineToolCopy('创建本地提交', '正在创建本地提交', '已创建本地提交', '创建本地提交失败', {
            defaultTarget: 'Git 提交',
        }),
    },
    {
        pattern: /^(?:get_git_diff|get_changed_files|github_repo)$/u,
        definition: defineToolCopy('检查 Git 变更', '正在检查 Git 变更', '已检查 Git 变更', '检查 Git 变更失败', {
            defaultTarget: 'Git 变更',
            preferFileChip: true,
            fileLead: '涉及 ',
        }),
    },
    {
        pattern: /^(?:memory|resolve_memory_file_uri)$/u,
        definition: defineToolCopy('读写记忆', '正在读写记忆', '已完成记忆操作', '记忆操作失败', {
            defaultTarget: '记忆条目',
        }),
    },
    {
        pattern: /^(?:manage_todo_list)$/u,
        definition: defineToolCopy('更新执行计划', '正在更新执行计划', '已更新执行计划', '更新执行计划失败', {
            defaultTarget: '任务清单',
        }),
    },
    {
        pattern: /^(?:runsubagent)$/u,
        definition: defineToolCopy('调度子代理', '正在调度子代理', '已调度子代理', '调度子代理失败', {
            defaultTarget: '子代理任务',
        }),
    },
    {
        pattern: /^(?:vscode_askquestions)$/u,
        definition: defineToolCopy('等待用户确认', '正在等待用户确认', '已收到用户确认', '用户确认失败', {
            defaultTarget: '确认请求',
        }),
    },
    {
        pattern: /^(?:configure_python_environment|install_python_packages|get_python_environment_details|get_python_executable_details|mcp_pylance_mcp_s_pylancepythonenvironments|mcp_pylance_mcp_s_pylanceupdatepythonenvironment|mcp_pylance_mcp_s_pylanceinstalledtoplevelmodules)$/u,
        definition: defineToolCopy('处理 Python 环境', '正在处理 Python 环境', '已完成 Python 环境处理', 'Python 环境处理失败', {
            defaultTarget: 'Python 环境',
        }),
    },
    {
        pattern: /^(?:mcp_pylance_mcp_s_pylanceruncodesnippet)$/u,
        definition: defineToolCopy('执行 Python 代码', '正在执行 Python 代码', '已执行 Python 代码', '执行 Python 代码失败', {
            defaultTarget: 'Python 片段',
        }),
    },
    {
        pattern: /^(?:mcp_pylance_mcp_s_pylancesyntaxerrors)$/u,
        definition: defineToolCopy('检查 Python 语法', '正在检查 Python 语法', '已完成 Python 语法检查', 'Python 语法检查失败', {
            defaultTarget: 'Python 代码',
        }),
    },
    {
        pattern: /^(?:mcp_pylance_mcp_s_pylancedocstring|mcp_pylance_mcp_s_pylancedocuments|mcp_pylance_mcp_s_pylanceimports|mcp_pylance_mcp_s_pylancesettings|mcp_pylance_mcp_s_pylanceworkspaceroots|mcp_pylance_mcp_s_pylanceworkspaceuserfiles)$/u,
        definition: defineToolCopy('分析 Python 上下文', '正在分析 Python 上下文', '已完成 Python 上下文分析', 'Python 上下文分析失败', {
            defaultTarget: 'Python 工程',
        }),
    },
    {
        pattern: /^(?:debug_java_application|get_debug_session_info|get_debug_threads|get_debug_stack_trace|get_debug_variables|evaluate_debug_expression|debug_step_operation|set_java_breakpoint|remove_java_breakpoints|stop_debug_session)$/u,
        definition: defineToolCopy('调试 Java 应用', '正在调试 Java 应用', '已完成 Java 调试操作', 'Java 调试操作失败', {
            defaultTarget: 'Java 调试会话',
        }),
    },
    {
        pattern: /^(?:rendermermaiddiagram)$/u,
        definition: defineToolCopy('渲染 Mermaid 图表', '正在渲染 Mermaid 图表', '已渲染 Mermaid 图表', '渲染 Mermaid 图表失败', {
            defaultTarget: 'Mermaid 图表',
        }),
    },
    {
        pattern: /^(?:container-tools_get-config)$/u,
        definition: defineToolCopy('读取容器配置', '正在读取容器配置', '已读取容器配置', '读取容器配置失败', {
            defaultTarget: '容器环境',
        }),
    },
]

const TOOL_KIND_FALLBACKS: Readonly<Record<TAiRuntimeToolKind, IToolCopyDefinition>> = {
    search: defineToolCopy('搜索工作区', '正在搜索工作区', '已完成工作区搜索', '工作区搜索失败', {
        defaultTarget: '搜索结果',
    }),
    read: defineToolCopy('读取上下文', '正在读取上下文', '已读取上下文', '读取上下文失败', {
        defaultTarget: '上下文',
    }),
    write: defineToolCopy('修改工作区', '正在修改工作区', '已修改工作区', '修改工作区失败', {
        defaultTarget: '工作区改动',
        preferFileChip: true,
        fileLead: '处理 ',
    }),
    git: defineToolCopy('处理 Git 状态', '正在处理 Git 状态', '已处理 Git 状态', '处理 Git 状态失败', {
        defaultTarget: 'Git 变更',
    }),
    browser: defineToolCopy('操作浏览器页面', '正在操作浏览器页面', '已完成页面操作', '页面操作失败', {
        defaultTarget: '页面上下文',
    }),
    terminal: defineToolCopy('执行终端命令', '正在执行终端命令', '已执行终端命令', '终端命令执行失败', {
        defaultTarget: '终端命令',
    }),
    task: defineToolCopy('协调任务流程', '正在协调任务流程', '已协调任务流程', '任务流程协调失败', {
        defaultTarget: '任务编排',
    }),
    network: defineToolCopy('调用外部服务', '正在调用外部服务', '已完成外部服务调用', '外部服务调用失败', {
        defaultTarget: '外部能力',
    }),
    diagram: defineToolCopy('生成图表', '正在生成图表', '已生成图表', '图表生成失败', {
        defaultTarget: '图表结果',
    }),
    symbol: defineToolCopy('分析符号', '正在分析符号', '已完成符号分析', '符号分析失败', {
        defaultTarget: '符号结果',
    }),
    python: defineToolCopy('处理 Python 任务', '正在处理 Python 任务', '已完成 Python 任务', 'Python 任务处理失败', {
        defaultTarget: 'Python 上下文',
    }),
    java: defineToolCopy('处理 Java 调试', '正在处理 Java 调试', '已完成 Java 调试', 'Java 调试失败', {
        defaultTarget: 'Java 调试',
    }),
    memory: defineToolCopy('处理记忆数据', '正在处理记忆数据', '已处理记忆数据', '记忆数据处理失败', {
        defaultTarget: '记忆条目',
    }),
    thinking: defineToolCopy('整理推理链路', '正在整理推理链路', '已整理推理链路', '推理链路整理失败', {
        defaultTarget: '推理步骤',
    }),
    system: defineToolCopy('执行工具调用', '正在执行工具调用', '已执行工具调用', '工具调用失败', {
        defaultTarget: '工具请求',
    }),
}

const normalizeWorkflowToolName = (toolName: string): string =>
    normalizeRuntimeToolName(toolName)
        .replace(/^multi_tool_use\./u, '')
        .trim()

const normalizeTaskLine = (value: string | null | undefined): string =>
    normalizePreviewText(value ?? '').replace(/[。.]$/u, '').trim()

const getFileExtension = (value: string): string => {
    const name = getPathBaseName(value).toLowerCase()
    const index = name.lastIndexOf('.')

    return index >= 0 ? name.slice(index + 1) : ''
}

const inferLegacyIcon = (value: string): IconKey => {
    const extension = getFileExtension(value)
    return LEGACY_FILE_ICON_BY_EXTENSION[extension] ?? 'json'
}

const sanitizePathCandidate = (value: string): string => {
    const normalized = normalizeTaskLine(value).replace(FILE_REFERENCE_PREFIX_PATTERN, '')
    return parseTarget(normalized).target.replace(/[),;，。]+$/u, '').trim()
}

const isLikelyFilePath = (value: string): boolean => {
    const candidate = sanitizePathCandidate(value)

    if (!candidate || /^https?:\/\//iu.test(candidate)) {
        return false
    }

    return /[\\/]/u.test(candidate) || Boolean(LEGACY_FILE_ICON_BY_EXTENSION[getFileExtension(candidate)])
}

const extractFilePathsFromText = (value: string | null | undefined): string[] => {
    const normalized = normalizeTaskLine(value)
    if (!normalized) {
        return []
    }

    const matches = new Set<string>()
    const directCandidate = sanitizePathCandidate(normalized)
    if (isLikelyFilePath(directCandidate)) {
        matches.add(directCandidate)
    }

    for (const pattern of [FILE_PATH_INLINE_PATTERN, FILE_NAME_INLINE_PATTERN]) {
        const found = normalized.match(pattern) ?? []
        for (const candidate of found) {
            const sanitized = sanitizePathCandidate(candidate)
            if (isLikelyFilePath(sanitized)) {
                matches.add(sanitized)
            }
        }
    }

    return [...matches]
}

const createTaskItemKey = (item: TaskItemData): string =>
    item.type === 'text'
        ? `text:${normalizeTaskLine(item.text).toLowerCase()}`
        : `file:${normalizeTaskLine(item.text).toLowerCase()}:${normalizeTaskLine(item.file.path ?? item.file.name).toLowerCase()}`

const appendUniqueTaskItem = (items: TaskItemData[], item: TaskItemData): void => {
    const key = createTaskItemKey(item)
    if (!key || items.some((candidate) => createTaskItemKey(candidate) === key)) {
        return
    }

    items.push(item)
}

const appendUniqueText = (items: TaskItemData[], value: string | null | undefined): void => {
    const normalized = normalizeTaskLine(value)
    if (!normalized) {
        return
    }

    appendUniqueTaskItem(items, t(normalized))
}

const appendUniqueFile = (items: TaskItemData[], prefix: string, file: FileMeta): void => {
    appendUniqueTaskItem(items, f(prefix, file))
}

const resolveToolCopyDefinition = (toolName: string): IToolCopyDefinition => {
    const normalized = normalizeWorkflowToolName(toolName).toLowerCase()

    for (const matcher of TOOL_COPY_MATCHERS) {
        if (matcher.pattern.test(normalized)) {
            return matcher.definition
        }
    }

    const kind = classifyRuntimeToolKind(normalized)
    return TOOL_KIND_FALLBACKS[kind]
}

const resolveToolTarget = (tool: IMcpToolTaskInput, definition: IToolCopyDefinition): string => {
    const candidates = [
        tool.targetPreview,
        stripTargetNoise(tool.summary ?? ''),
        ...(tool.detailItems ?? []).map((item) => item.replace(FILE_REFERENCE_PREFIX_PATTERN, '')),
    ]

    for (const candidate of candidates) {
        const normalized = normalizeTaskLine(candidate)
        if (!normalized || TOOL_SUMMARY_NOISE_PATTERNS.some((pattern) => pattern.test(normalized))) {
            continue
        }

        const parsed = parseTarget(normalized)
        const target = parsed.target.trim()
        if (!target) {
            continue
        }

        return parsed.lineRange ? `${target} ${parsed.lineRange}` : target
    }

    return definition.defaultTarget ?? ''
}

const resolveSummaryLine = (tool: IMcpToolTaskInput, target: string): string | null => {
    const summary = normalizeTaskLine(tool.summary)
    if (!summary || TOOL_SUMMARY_NOISE_PATTERNS.some((pattern) => pattern.test(summary))) {
        return null
    }

    const normalizedTarget = normalizeTaskLine(target)
    if (!normalizedTarget) {
        return summary
    }

    const strippedSummary = normalizeTaskLine(stripTargetNoise(summary))
    if (!strippedSummary || strippedSummary === normalizedTarget) {
        return null
    }

    return summary
}

const resolveDetailLines = (
    tool: IMcpToolTaskInput,
    files: readonly FileMeta[],
    summaryLine: string | null,
): string[] => {
    const fileKeys = new Set(
        files.flatMap((file) => [normalizeTaskLine(file.path).toLowerCase(), normalizeTaskLine(file.name).toLowerCase()]),
    )

    return [...new Set((tool.detailItems ?? []).map((item) => normalizeTaskLine(item)).filter(Boolean))]
        .filter((item) => !TOOL_SUMMARY_NOISE_PATTERNS.some((pattern) => pattern.test(item)))
        .filter((item) => normalizeTaskLine(item).toLowerCase() !== normalizeTaskLine(summaryLine).toLowerCase())
        .filter((item) => !fileKeys.has(sanitizePathCandidate(item).toLowerCase()))
        .slice(0, MAX_TOOL_DETAIL_ITEMS)
}

const extractToolFiles = (tool: IMcpToolTaskInput): FileMeta[] => {
    const candidates = [
        ...(tool.targetPreview ? extractFilePathsFromText(tool.targetPreview) : []),
        ...extractFilePathsFromText(tool.summary),
        ...(tool.detailItems ?? []).flatMap((item) => extractFilePathsFromText(item)),
    ]

    const uniquePaths = [...new Set(candidates.map((value) => sanitizePathCandidate(value)).filter(Boolean))]
    return uniquePaths.slice(0, MAX_TOOL_FILE_ITEMS).map((path) => createFileMetaFromPath(path))
}

const buildToolPendingItems = (definition: IToolCopyDefinition): TaskItemData[] => [
    t(`等待${definition.title}`),
]

const buildToolRunningItems = (
    tool: IMcpToolTaskInput,
    definition: IToolCopyDefinition,
    target: string,
    files: readonly FileMeta[],
): TaskItemData[] => {
    const items: TaskItemData[] = []

    appendUniqueText(items, target ? `${definition.running}：${target}` : `${definition.running}…`)
    if (definition.preferFileChip && files[0]) {
        appendUniqueFile(items, definition.fileLead ?? '处理 ', files[0])
    }

    const summaryLine = resolveSummaryLine(tool, target)
    appendUniqueText(items, summaryLine)
    for (const detail of resolveDetailLines(tool, files, summaryLine).slice(0, 2)) {
        appendUniqueText(items, detail)
    }

    return items.length ? items : [t(`${definition.running}…`)]
}

const buildToolCompletedItems = (
    tool: IMcpToolTaskInput,
    definition: IToolCopyDefinition,
    target: string,
    files: readonly FileMeta[],
): TaskItemData[] => {
    const items: TaskItemData[] = []

    if (definition.preferFileChip && files.length) {
        for (const file of files) {
            appendUniqueFile(items, definition.fileLead ?? '处理 ', file)
        }
    } else {
        appendUniqueText(items, target ? `${definition.completed}：${target}` : definition.completed)
    }

    const summaryLine = resolveSummaryLine(tool, target)
    appendUniqueText(items, summaryLine)

    for (const detail of resolveDetailLines(tool, files, summaryLine)) {
        appendUniqueText(items, detail)
    }

    const elapsedLabel = formatToolElapsed(tool.elapsedMs)
    appendUniqueText(items, elapsedLabel ? `耗时 ${elapsedLabel}` : null)

    return items.length ? items : [t(definition.completed)]
}

const buildToolErrorItems = (
    tool: IMcpToolTaskInput,
    definition: IToolCopyDefinition,
    target: string,
    files: readonly FileMeta[],
): TaskItemData[] => {
    const items: TaskItemData[] = []
    const denied = tool.status === 'denied'

    appendUniqueText(items, denied ? `已拒绝${definition.title}` : definition.failed)
    if (definition.preferFileChip && files[0]) {
        appendUniqueFile(items, definition.fileLead ?? '目标 ', files[0])
    } else if (target) {
        appendUniqueText(items, `目标：${target}`)
    }

    const summaryLine = resolveSummaryLine(tool, target)
    appendUniqueText(items, summaryLine ?? tool.summary)

    for (const detail of resolveDetailLines(tool, files, summaryLine)) {
        appendUniqueText(items, detail)
    }

    return items.length ? items : [t(denied ? `已拒绝${definition.title}` : definition.failed)]
}

/**
 * 根据文件路径生成可直接供 TaskItemFile 渲染的文件元数据。
 */
export const createFileMetaFromPath = (
    path: string,
    options: ICreateFileMetaOptions = {},
): FileMeta => {
    const normalizedPath = sanitizePathCandidate(path)
    const kind = options.kind ?? 'file'
    const name = options.name ?? getPathBaseName(normalizedPath) ?? normalizedPath

    return {
        name,
        icon: inferLegacyIcon(name),
        color: options.color,
        path: normalizedPath,
        kind,
        themeIconKey: resolveFileIconKey({ kind, path: normalizedPath }),
        iconAsset: resolveFileIconAsset({ kind, path: normalizedPath }),
    }
}

/**
 * 为现有 TaskItemFile 结构创建一条带文件图标元数据的文件项。
 */
export const createFileTaskItem = (
    text: string,
    path: string,
    options: ICreateFileMetaOptions = {},
): TaskItemData => f(text, createFileMetaFromPath(path, options))

/**
 * 将单个工具调用转换为可直接驱动 Task 组件的任务块。
 */
export function buildMcpToolTask(tool: IMcpToolTaskInput): TaskBlock {
    const definition = resolveToolCopyDefinition(tool.name)
    const status = TOOL_STATUS_TO_TASK_STATUS[tool.status]
    const target = resolveToolTarget(tool, definition)
    const files = extractToolFiles(tool)

    return {
        title: definition.title,
        status,
        items:
            status === 'pending'
                ? buildToolPendingItems(definition)
                : status === 'in_progress'
                    ? buildToolRunningItems(tool, definition, target, files)
                    : status === 'completed'
                        ? buildToolCompletedItems(tool, definition, target, files)
                        : buildToolErrorItems(tool, definition, target, files),
    }
}

/**
 * 将一组工具调用顺序展开为 TaskBlock 数组，供调用方逐个渲染为 Task 组件。
 */
export function buildMcpToolTasks(tools: readonly IMcpToolTaskInput[]): TaskBlock[] {
    return tools.map((tool) => buildMcpToolTask(tool))
}