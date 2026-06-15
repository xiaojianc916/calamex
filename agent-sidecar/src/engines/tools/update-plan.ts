import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createJsonToolModelOutput } from '../budget/budget.js';
import { resolveWorkspaceDirectory } from '../context/context.js';
import { toNonEmptyString } from '../utils.js';

/**
 * update_plan —— Plan 模式「活体 PLAN.md」编辑工具（方案 A，纯 OpenHands 式）。
 *
 * 设计取舍（对标成熟实现，不自创逻辑）：
 * - 形态/职责 ← OpenHands software-agent-sdk `PlanningFileEditorTool`
 *   (openhands-tools/openhands/tools/preset/planning.py)：规划阶段唯一的「可写」工具，
 *   写权限随工具走、独立于只读工作区；落地一个结构化的 living PLAN.md（OpenHands
 *   get_plan_headers 用 `# N. {title}` 章节初始化，且「plan 必须严格遵循该结构」）。
 * - 只读边界 ← OpenHands get_planning_tools：plan agent 仅持 Glob/Grep（只读）+ 本工具；
 *   本仓 plan 模式已用 workspace profile='readonly' 把 write_file/edit_file/exec 全部禁用
 *   （见 workspace.ts，LocalFilesystem readOnly），故 PLAN.md 不能走工作区写工具，必须由
 *   本工具自带的、绕过只读工作区的独立 fs 写权限落盘——这正是 PlanningFileEditorTool 的核心。
 * - 工具编写范式 ← 本仓 ask-user.ts：createTool + zod inputSchema/outputSchema +
 *   createJsonToolModelOutput + createXxxTools 工厂返回 ToolsInput 记录。
 *
 * 与 OpenHands 的有意偏离（均服务于本仓 PLAN→stepIds 执行桥，非自创逻辑）：
 * - 采用「整篇覆盖」而非 str_replace 文件编辑：plan 文档体量小、整体重写确定性更高，
 *   且规避大 payload str_replace 的截断脆弱性；仍保留 view 以便模型读取当前 PLAN.md。
 * - 强制一个 canonical Steps 区：其有序列表项 = 后续 exit_plan 解析出的 stepIds，是
 *   「living 文本计划」与既有结构化编排（plan-store / orchestration）之间的桥。
 * - 结构校验取「软校验」：缺章节时在工具结果里回传明确告警让模型自纠，而非硬失败中断
 *   规划循环（对模型更鲁棒）。
 *
 * 说明：OpenHands PLAN_STRUCTURE 的逐字章节标题本会话未能从源码取回，故此处镜像其公开
 * 文档所述结构（问题/分析 → 有序实现步骤），并适配本仓执行桥所需的 canonical Steps 区。
 */

export const PLAN_FILE_NAME = 'PLAN.md';

// canonical 章节（对标 OpenHands PLAN_STRUCTURE: [title, description][] + get_plan_headers）。
export interface IPlanSection {
    title: string;
    description: string;
}

export const PLAN_STRUCTURE: ReadonlyArray<IPlanSection> = Object.freeze([
    { title: 'Goal', description: '一句话说明目标：做什么、为什么。' },
    { title: 'Context & Constraints', description: '相关现状、依赖、约束与风险。' },
    { title: 'Approach', description: '总体思路与关键取舍（必要时含被否决的备选）。' },
    { title: 'Steps', description: '有序的可执行步骤；每个列表项 = 一个步骤，执行阶段据此逐步推进。' },
    { title: 'Verification', description: '验收标准与测试 / 门禁，用于判断计划是否达成。' },
]);

// canonical 步骤区标题（PLAN→stepIds 桥的解析锚点；与 PLAN_STRUCTURE 中的 Steps 一致）。
export const PLAN_STEPS_SECTION_TITLE = 'Steps';

// 对标 OpenHands get_plan_headers：用 `# N. {title}` 生成 PLAN.md 初始骨架（附章节提示）。
export const renderPlanScaffold = (): string =>
    PLAN_STRUCTURE.map(
        (section, index) => `# ${index + 1}. ${section.title}\n\n_${section.description}_\n`,
    ).join('\n');

// 解析 PLAN.md 落盘绝对路径：优先工作区根（纯 OpenHands 式，plan 落在工作区内）；无工作区时
// 回退到 sidecar 托管、按 thread 隔离的临时计划目录（保证未打开任何文件夹时仍可规划）。
// update_plan 写入与 exit_plan 解析必须共用本解析器，保证读写指向同一文件。
export const resolvePlanFilePath = (args: {
    workspaceRootPath?: string | undefined;
    threadId?: string | undefined;
}): string => {
    const workspaceDirectory = resolveWorkspaceDirectory(args.workspaceRootPath);
    if (workspaceDirectory) {
        return join(workspaceDirectory, PLAN_FILE_NAME);
    }
    const threadKey = toNonEmptyString(args.threadId ?? null) ?? 'default';
    const safeThreadKey = threadKey.replace(/[^\w.-]+/gu, '_');
    return join(tmpdir(), '.calamex-plans', safeThreadKey, PLAN_FILE_NAME);
};

// ---------------------------------------------------------------------------
// 结构软校验 + 步骤解析：按章节标题判断 PLAN.md 是否覆盖 canonical 结构；并把 Steps 区的
// 顶层列表项解析为有序步骤文本（exit_plan 校验 + T3.4 执行桥共用）。
// ---------------------------------------------------------------------------
const HEADING_LINE = /^#{1,6}\s+(?:\d+\.\s+)?(.+?)\s*$/u;
// 列表项：支持 -/*/+ 与有序 N. / N)，可带 GFM 复选框 [ ]/[x]。
const PLAN_STEP_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/u;

const collectHeadingTitles = (markdown: string): string[] =>
    markdown
        .split('\n')
        .map((line) => {
            const match = HEADING_LINE.exec(line);
            const title = match?.[1];
            return title === undefined ? null : title.trim().toLowerCase();
        })
        .filter((title): title is string => title !== null);

export const findMissingPlanSections = (markdown: string): string[] => {
    const headingTitles = collectHeadingTitles(markdown);
    return PLAN_STRUCTURE.filter(
        (section) => !headingTitles.some((title) => title.includes(section.title.toLowerCase())),
    ).map((section) => section.title);
};

// 把 PLAN.md 的 Steps 区解析为有序步骤文本列表（PLAN→stepIds 桥的核心）。
// 规则：定位标题含 canonical Steps 的小节 → 收集到下一个标题之前的列表项 → 仅取最浅缩进层级
//（顶层项 = 步骤，更深缩进视为该步骤的细节/子项，不另算步骤）。
export const parsePlanSteps = (markdown: string): string[] => {
    const target = PLAN_STEPS_SECTION_TITLE.toLowerCase();
    let inStepsSection = false;
    const collected: Array<{ indent: number; text: string }> = [];

    for (const line of markdown.split('\n')) {
        const heading = HEADING_LINE.exec(line);
        if (heading) {
            // 进入/离开 Steps 区：遇到下一个标题（标题不含 Steps）即自动结束本区。
            const headingTitle = heading[1] ?? '';
            inStepsSection = headingTitle.trim().toLowerCase().includes(target);
            continue;
        }
        if (!inStepsSection) {
            continue;
        }
        const item = PLAN_STEP_LINE.exec(line);
        if (item) {
            const indent = item[1] ?? '';
            const text = item[2] ?? '';
            collected.push({ indent: indent.length, text: text.trim() });
        }
    }

    if (collected.length === 0) {
        return [];
    }
    const minIndent = Math.min(...collected.map((entry) => entry.indent));
    return collected
        .filter((entry) => entry.indent === minIndent && entry.text.length > 0)
        .map((entry) => entry.text);
};

// ---------------------------------------------------------------------------
// 入参 / 出参 schema（根为 ZodObject，跨字段约束放到 execute，避免根级 ZodEffects）。
// ---------------------------------------------------------------------------
const updatePlanInputSchema = z.object({
    command: z
        .enum(['view', 'write'])
        .describe("'view' 读取当前 PLAN.md（不存在则返回结构骨架模板）；'write' 用 content 整篇覆盖 PLAN.md。"),
    content: z
        .string()
        .optional()
        .describe("command='write' 时必填：完整的 PLAN.md markdown，需遵循固定章节结构（见工具描述）。"),
});

export type TUpdatePlanInput = z.infer<typeof updatePlanInputSchema>;

const updatePlanOutputSchema = z.object({
    command: z.enum(['view', 'write']),
    path: z.string(),
    created: z.boolean(),
    bytes: z.number(),
    content: z.string(),
    missingSections: z.array(z.string()).default([]),
    display: z.string(),
});

export type TUpdatePlanResult = z.infer<typeof updatePlanOutputSchema>;

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
export const createUpdatePlanTool = (planFilePath: string): ReturnType<typeof createTool> =>
    createTool({
        id: 'update_plan',
        description: [
            'Create or update the living PLAN.md for plan mode (the single writable artifact while planning).',
            "command='view' returns the current PLAN.md (or a structure scaffold if none exists yet);",
            "command='write' overwrites PLAN.md with your full markdown 'content'.",
            'PLAN.md MUST follow this section structure (use `# N. Title` headings): ' +
                PLAN_STRUCTURE.map((section, index) => `${index + 1}. ${section.title}`).join(', ') +
                '.',
            "The 'Steps' section must list ordered, actionable steps (one list item per step); these become the executable steps once you call exit_plan.",
            'Do not attempt to edit any other file while planning — only this tool can write, and only to PLAN.md.',
        ].join(' '),
        inputSchema: updatePlanInputSchema,
        outputSchema: updatePlanOutputSchema,
        execute: async (inputData) => {
            const exists = existsSync(planFilePath);

            if (inputData.command === 'view') {
                const content = exists ? readFileSync(planFilePath, 'utf-8') : renderPlanScaffold();
                return {
                    command: 'view' as const,
                    path: planFilePath,
                    created: false,
                    bytes: Buffer.byteLength(content, 'utf-8'),
                    content,
                    missingSections: findMissingPlanSections(content),
                    display: exists
                        ? `**Current PLAN.md** (${planFilePath})`
                        : 'PLAN.md 尚不存在；已返回结构骨架模板供填写。',
                };
            }

            // command === 'write'：跨字段约束（根 schema 不便表达）在此把关。
            const content = inputData.content ?? '';
            if (content.trim().length === 0) {
                throw new Error("update_plan command='write' 需要非空的 'content'（完整 PLAN.md 内容）。");
            }

            mkdirSync(dirname(planFilePath), { recursive: true });
            writeFileSync(planFilePath, content, 'utf-8');

            const missingSections = findMissingPlanSections(content);
            const display =
                missingSections.length > 0
                    ? `**PLAN.md updated** (${planFilePath})\n⚠ 缺少建议章节：${missingSections.join('、')}（请补全后再 exit_plan）。`
                    : `**PLAN.md updated** (${planFilePath})`;

            return {
                command: 'write' as const,
                path: planFilePath,
                created: !exists,
                bytes: Buffer.byteLength(content, 'utf-8'),
                content,
                missingSections,
                display,
            };
        },
        toModelOutput: (output) => createJsonToolModelOutput(output),
    });

// 工具装配入口（与 createAskUserTools / createUiContextTools 同构，返回工具记录）。
export const createUpdatePlanTools = (planFilePath: string): ToolsInput => ({
    update_plan: createUpdatePlanTool(planFilePath),
});
