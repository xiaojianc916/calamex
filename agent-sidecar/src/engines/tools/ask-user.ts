import type { ToolsInput } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { createJsonToolModelOutput } from '../budget/budget.js';

/**
 * ask_user —— AI 反向提问（HITL）原生工具。
 *
 * 设计取舍（取长补短，全程对标成熟实现，不自创逻辑）：
 * - 问答语义层 ← Gemini CLI `ask_user`（google-gemini/gemini-cli）：
 *   header(<=16 字符) + question + type('choice'|'text'|'yesno')；choice 需 2-4 个
 *   {label, description}；`unescape` 把字面量 \r\n / \n 归一为真实换行；
 *   returnDisplay 用 `**User answered:**\n  {header} -> {answer}`。
 * - 协议/结果层 ← ACP `session/request_permission`：结果是 outcome 判别联合
 *   ('selected' | 'cancelled')；每个可选项带稳定 optionId（host 以 optionId 回填答案，
 *   而非脆弱的下标/文案）。
 * - 挂起/恢复机制 ← Mastra 工具级 suspend（@mastra/core agent-approval）：
 *   execute(inputData, context) 内 `const { resumeData, suspend } = context.agent`；
 *   未恢复时 `return await suspend(request)`（不抛异常、立即返回）；
 *   恢复时 resumeData 即用户回填（resumeSchema 结构），格式化后返回给模型。
 *
 * 说明：模型只需按 Gemini 形态填 questions（无需自造 id）；稳定的 questionId/optionId
 * 由本工具在构造挂起负载（suspendSchema）时确定，前端据此渲染、host 据此回填（resumeSchema）。
 */

// 字符上限对齐 Gemini ask_user：header 是紧凑分类标签。
const HEADER_MAX_CHARS = 16;

export type TQuestionType = 'choice' | 'text' | 'yesno';
export type TAskUserOutcome = 'selected' | 'cancelled';

// ---------------------------------------------------------------------------
// 模型侧入参：刻意贴近 Gemini ask_user 形态——只填语义，不造 id。
// ---------------------------------------------------------------------------
const optionInputSchema = z.object({
    label: z
        .string()
        .trim()
        .min(1, 'option.label 必须为非空字符串')
        .describe('Short selectable label (1-5 words).'),
    description: z
        .string()
        .describe('One-line explanation of what choosing this option means (may be empty).'),
});

const questionInputSchema = z.object({
    question: z.string().min(1).describe('The question to ask the user.'),
    header: z
        .string()
        .trim()
        .min(1)
        .max(HEADER_MAX_CHARS, `header 不能超过 ${HEADER_MAX_CHARS} 个字符`)
        .describe('Compact category chip (<=16 chars) shown above the question.'),
    type: z
        .enum(['choice', 'text', 'yesno'])
        .describe("'choice'=2-4 个选项；'text'=自由文本；'yesno'=是/否。"),
    options: z
        .array(optionInputSchema)
        .min(2)
        .max(4)
        .optional()
        .describe("Selectable options. REQUIRED for type='choice'; ignored otherwise."),
    multiSelect: z
        .boolean()
        .optional()
        .describe("Allow multiple selections. Only applies when type='choice'."),
    placeholder: z
        .string()
        .optional()
        .describe("Placeholder for the free-text input (text type, or the always-present Other row)."),
});

// 等价于 Gemini validateToolParamValues 的跨字段约束：
// choice 必须带 2-4 个选项（数量上限由 array.min/max 把关，此处补「choice 必须有 options」）。
const askUserInputSchema = z.object({
    questions: z
        .array(questionInputSchema)
        .min(1, 'At least one question is required.')
        .max(4, '一次最多 4 个问题')
        .superRefine((questions, ctx) => {
            questions.forEach((question, index) => {
                if (question.type === 'choice' && (!question.options || question.options.length < 2)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: [index, 'options'],
                        message: `Question ${index + 1}: type='choice' requires 'options' array with 2-4 items.`,
                    });
                }
            });
        }),
});

export type TAskUserInput = z.infer<typeof askUserInputSchema>;

// ---------------------------------------------------------------------------
// 挂起负载（suspendSchema）：携带本工具分配的稳定 questionId/optionId，供前端渲染。
// ---------------------------------------------------------------------------
const surfacedOptionSchema = z.object({
    optionId: z.string(),
    label: z.string(),
    description: z.string(),
});

const surfacedQuestionSchema = z.object({
    questionId: z.string(),
    question: z.string(),
    header: z.string(),
    type: z.enum(['choice', 'text', 'yesno']),
    options: z.array(surfacedOptionSchema).optional(),
    multiSelect: z.boolean().optional(),
    placeholder: z.string().optional(),
});

const askUserRequestSchema = z.object({
    kind: z.literal('user_question'),
    questions: z.array(surfacedQuestionSchema).min(1),
});

export type TAskUserRequest = z.infer<typeof askUserRequestSchema>;
export type TSurfacedQuestion = z.infer<typeof surfacedQuestionSchema>;

// ---------------------------------------------------------------------------
// 恢复负载（resumeSchema）：host 回填的答案，以 optionId 寻址（对标 ACP outcome）。
// ---------------------------------------------------------------------------
const answerSchema = z.object({
    questionId: z.string(),
    optionIds: z.array(z.string()).default([]),
    text: z.string().optional(),
});

const askUserResultSchema = z.object({
    outcome: z.enum(['selected', 'cancelled']),
    answers: z.array(answerSchema).optional(),
});

export type TAskUserResult = z.infer<typeof askUserResultSchema>;

// 返回给运行时/模型的结果结构。
const askUserOutputSchema = z.object({
    outcome: z.enum(['selected', 'cancelled']),
    display: z.string(),
    answers: z
        .array(
            z.object({
                questionId: z.string(),
                header: z.string(),
                answer: z.string(),
            }),
        )
        .default([]),
    dismissed: z.boolean(),
    emptySubmission: z.boolean(),
});

// ---------------------------------------------------------------------------
// 工具内部辅助
// ---------------------------------------------------------------------------

// 对标 Gemini ask_user 的 unescape：把字面量 \r\n / \n 归一为真实换行。
const unescape = (value: string): string => value.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');

const questionIdOf = (index: number): string => `q${index + 1}`;
const optionIdOf = (questionId: string, index: number): string => `${questionId}-o${index + 1}`;

// 是/否合成两个稳定 optionId（仍走 ACP optionId 答案模型，前端渲染为 是/否）。
const YESNO_OPTIONS: ReadonlyArray<{ optionId: string; label: string }> = Object.freeze([
    { optionId: 'yes', label: '是' },
    { optionId: 'no', label: '否' },
]);

// 把模型入参规范化为带稳定 id 的挂起请求（含 unescape 归一）。
const buildAskUserRequest = (input: TAskUserInput): TAskUserRequest => ({
    kind: 'user_question',
    questions: input.questions.map((question, questionIndex) => {
        const questionId = questionIdOf(questionIndex);
        const base: TSurfacedQuestion = {
            questionId,
            question: unescape(question.question),
            header: unescape(question.header),
            type: question.type,
            ...(question.placeholder ? { placeholder: unescape(question.placeholder) } : {}),
        };
        if (question.type === 'choice') {
            return {
                ...base,
                ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
                options: (question.options ?? []).map((option, optionIndex) => ({
                    optionId: optionIdOf(questionId, optionIndex),
                    label: unescape(option.label),
                    description: option.description.trim() ? unescape(option.description.trim()) : '',
                })),
            };
        }
        if (question.type === 'yesno') {
            return {
                ...base,
                options: YESNO_OPTIONS.map((option) => ({
                    optionId: option.optionId,
                    label: option.label,
                    description: '',
                })),
            };
        }
        return base;
    }),
});

// 把单题答案拼成可读文本：所选项 label + 自由文本（Other），多行用换行连接。
const answerTextForQuestion = (
    question: TSurfacedQuestion,
    answer: { optionIds: string[]; text?: string } | undefined,
): string => {
    if (!answer) {
        return '';
    }
    const labelByOptionId = new Map((question.options ?? []).map((option) => [option.optionId, option.label]));
    const selectedLabels = answer.optionIds
        .map((optionId) => labelByOptionId.get(optionId) ?? optionId)
        .filter((label) => label.length > 0);
    const freeText = answer.text?.trim() ?? '';
    const parts = [...selectedLabels, ...(freeText ? [freeText] : [])];
    return parts.join('\n');
};

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------
export const createAskUserTool = (): ReturnType<typeof createTool> =>
    createTool({
        id: 'ask_user',
        description: [
            'Ask the user one or more questions and pause until they answer.',
            'Use ONLY when you genuinely need user input to proceed (a decision, missing info, or confirmation) — never for rhetorical questions.',
            "Each question has a compact 'header' (<=16 chars), the 'question' text, and a 'type':",
            "'choice' (2-4 options, each {label, description}; set multiSelect to allow multiple),",
            "'text' (free-form input), or 'yesno' (Yes/No).",
            'The user can always type a free-form answer in addition to (or instead of) picking options.',
        ].join(' '),
        inputSchema: askUserInputSchema,
        suspendSchema: askUserRequestSchema,
        resumeSchema: askUserResultSchema,
        outputSchema: askUserOutputSchema,
        execute: async (inputData, context) => {
            // resumeData / suspend 由 Mastra 在 agent 上下文注入；当前 @mastra/core 版本
            // 的 execute 形参类型未严格暴露 context.agent，沿用本仓库既有的防御性读取风格。
            const { resumeData, suspend } = (context?.agent ?? {}) as {
                resumeData?: TAskUserResult;
                suspend?: (payload: TAskUserRequest) => Promise<unknown>;
            };

            const request = buildAskUserRequest(inputData);

            // 第一次进入：构造问答请求并挂起，等待 host 回填（对标 Mastra 工具级 suspend）。
            if (!resumeData) {
                if (!suspend) {
                    throw new Error(
                        'ask_user 需要支持工具级 suspend 的 agent runtime（缺少 context.agent.suspend）。',
                    );
                }
                // suspend() 不抛异常：必须立即 return（agent-approval 文档约定）。
                return await suspend(request);
            }

            // 用户取消（对标 ACP cancelled outcome）。
            if (resumeData.outcome === 'cancelled') {
                return {
                    outcome: 'cancelled' as const,
                    display: 'User dismissed dialog',
                    answers: [],
                    dismissed: true,
                    emptySubmission: true,
                };
            }

            // 已回填答案：按 questionId 关联问题，过滤空答（对标 Gemini 的 empty_submission 语义）。
            const questionById = new Map(request.questions.map((question) => [question.questionId, question]));
            const answers = (resumeData.answers ?? [])
                .map((answer) => {
                    const question = questionById.get(answer.questionId);
                    if (!question) {
                        return null;
                    }
                    const text = answerTextForQuestion(question, answer);
                    if (!text) {
                        return null;
                    }
                    return { questionId: question.questionId, header: question.header, answer: text };
                })
                .filter(
                    (entry): entry is { questionId: string; header: string; answer: string } => entry !== null,
                );

            const hasAnswers = answers.length > 0;
            // returnDisplay 对齐 Gemini ask_user：`**User answered:**` + 每行 `{header} -> {answer}`，
            // 多行答案按 header 前缀宽度缩进对齐。
            const display = hasAnswers
                ? `**User answered:**\n${answers
                      .map((entry) => {
                          const prefix = `  ${entry.header} -> `;
                          const indent = ' '.repeat(prefix.length);
                          return prefix + entry.answer.split('\n').join('\n' + indent);
                      })
                      .join('\n')}`
                : 'User submitted without answering questions.';

            return {
                outcome: 'selected' as const,
                display,
                answers,
                dismissed: false,
                emptySubmission: !hasAnswers,
            };
        },
        toModelOutput: (output) => createJsonToolModelOutput(output),
    });

// 工具装配入口（与 createUiContextTools / createMastraTimeTools 同构，返回工具记录）。
export const createAskUserTools = (): ToolsInput => ({
    ask_user: createAskUserTool(),
});
