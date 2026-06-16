import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    HEADER_MAX_CHARS,
    YESNO_OPTIONS,
    answerTextForQuestion,
    askUserInputSchema,
    askUserOutputSchema,
    askUserRequestSchema,
    askUserResultSchema,
    buildAskUserRequest,
    createAskUserTool,
    createAskUserTools,
    optionIdOf,
    questionIdOf,
    unescape,
} from '../../tools/interaction/ask-user.js';
import type { TSurfacedQuestion } from '../../tools/interaction/ask-user.js';

const surfacedChoice: TSurfacedQuestion = {
    questionId: 'q1',
    question: '选择方向?',
    header: '方向',
    type: 'choice',
    options: [
        { optionId: 'q1-o1', label: '方案 A', description: '' },
        { optionId: 'q1-o2', label: '方案 B', description: '' },
    ],
};

// --- unescape ----------------------------------------------------------
test('🔴 unescape 将字面量 \\n / \\r\\n 归一为真实换行', () => {
    assert.equal(unescape('a\\nb'), 'a\nb');
    assert.equal(unescape('a\\r\\nb'), 'a\nb');
    assert.equal(unescape('plain text'), 'plain text');
});

// --- id 生成 -----------------------------------------------------------
test('🟠 questionIdOf / optionIdOf 生成稳定层级 id', () => {
    assert.equal(questionIdOf(0), 'q1');
    assert.equal(questionIdOf(2), 'q3');
    assert.equal(optionIdOf('q1', 0), 'q1-o1');
    assert.equal(optionIdOf('q2', 3), 'q2-o4');
});

// --- 常量 --------------------------------------------------------------
test('🟡 HEADER_MAX_CHARS 对齐 Gemini ask_user 的紧凑标签上限', () => {
    assert.equal(HEADER_MAX_CHARS, 16);
});

test('🟡 YESNO_OPTIONS 提供稳定的 是/否 选项且被冻结', () => {
    assert.deepEqual(
        YESNO_OPTIONS.map((option) => [option.optionId, option.label]),
        [
            ['yes', '是'],
            ['no', '否'],
        ],
    );
    assert.ok(Object.isFrozen(YESNO_OPTIONS));
});

// --- buildAskUserRequest ----------------------------------------------
test('🔴 buildAskUserRequest 为 choice 分配稳定 id 并映射选项', () => {
    const request = buildAskUserRequest({
        questions: [
            {
                question: '选择方向?',
                header: '方向',
                type: 'choice',
                options: [
                    { label: '方案 A', description: '走 A' },
                    { label: '方案 B', description: '' },
                ],
            },
        ],
    });
    assert.deepEqual(request, {
        kind: 'user_question',
        questions: [
            {
                questionId: 'q1',
                question: '选择方向?',
                header: '方向',
                type: 'choice',
                options: [
                    { optionId: 'q1-o1', label: '方案 A', description: '走 A' },
                    { optionId: 'q1-o2', label: '方案 B', description: '' },
                ],
            },
        ],
    });
});

test('🔴 buildAskUserRequest 为 yesno 合成 是/否 选项', () => {
    const request = buildAskUserRequest({
        questions: [{ question: '继续吗?', header: '确认', type: 'yesno' }],
    });
    assert.deepEqual(request.questions, [
        {
            questionId: 'q1',
            question: '继续吗?',
            header: '确认',
            type: 'yesno',
            options: [
                { optionId: 'yes', label: '是', description: '' },
                { optionId: 'no', label: '否', description: '' },
            ],
        },
    ]);
});

test('🟠 buildAskUserRequest 保持 text 无选项并 unescape placeholder', () => {
    const request = buildAskUserRequest({
        questions: [{ question: '补充说明?', header: '说明', type: 'text', placeholder: 'l1\\nl2' }],
    });
    assert.deepEqual(request.questions, [
        { questionId: 'q1', question: '补充说明?', header: '说明', type: 'text', placeholder: 'l1\nl2' },
    ]);
});

test('🟠 buildAskUserRequest 仅在显式设置时保留 multiSelect', () => {
    const withFlag = buildAskUserRequest({
        questions: [
            {
                question: 'q',
                header: 'h',
                type: 'choice',
                multiSelect: true,
                options: [
                    { label: 'A', description: '' },
                    { label: 'B', description: '' },
                ],
            },
        ],
    });
    assert.deepEqual(withFlag.questions, [
        {
            questionId: 'q1',
            question: 'q',
            header: 'h',
            type: 'choice',
            multiSelect: true,
            options: [
                { optionId: 'q1-o1', label: 'A', description: '' },
                { optionId: 'q1-o2', label: 'B', description: '' },
            ],
        },
    ]);

    const withoutFlag = buildAskUserRequest({
        questions: [
            {
                question: 'q',
                header: 'h',
                type: 'choice',
                options: [
                    { label: 'A', description: '' },
                    { label: 'B', description: '' },
                ],
            },
        ],
    });
    assert.deepEqual(withoutFlag.questions, [
        {
            questionId: 'q1',
            question: 'q',
            header: 'h',
            type: 'choice',
            options: [
                { optionId: 'q1-o1', label: 'A', description: '' },
                { optionId: 'q1-o2', label: 'B', description: '' },
            ],
        },
    ]);
});

test('🟡 buildAskUserRequest 按 q1..qN 编号并 unescape 文案', () => {
    const request = buildAskUserRequest({
        questions: [
            { question: 'l1\\nl2', header: 'h1', type: 'text' },
            { question: 'b', header: 'h2', type: 'text' },
        ],
    });
    assert.deepEqual(request.questions, [
        { questionId: 'q1', question: 'l1\nl2', header: 'h1', type: 'text' },
        { questionId: 'q2', question: 'b', header: 'h2', type: 'text' },
    ]);
});

// --- answerTextForQuestion --------------------------------------------
test('🔴 answerTextForQuestion 解析选项 label 并附加自由文本', () => {
    assert.equal(
        answerTextForQuestion(surfacedChoice, { optionIds: ['q1-o1', 'q1-o2'], text: '另外' }),
        '方案 A\n方案 B\n另外',
    );
});

test('🟠 answerTextForQuestion 在 label 未知时回退到 optionId', () => {
    assert.equal(answerTextForQuestion(surfacedChoice, { optionIds: ['ghost'] }), 'ghost');
});

test('🟠 answerTextForQuestion 对空答案返回空串', () => {
    assert.equal(answerTextForQuestion(surfacedChoice, undefined), '');
    assert.equal(answerTextForQuestion(surfacedChoice, { optionIds: [] }), '');
    assert.equal(answerTextForQuestion(surfacedChoice, { optionIds: [], text: '   ' }), '');
});

test('🟡 answerTextForQuestion 处理纯文本题并 trim', () => {
    const textQuestion: TSurfacedQuestion = { questionId: 'q2', question: 'q', header: 'h', type: 'text' };
    assert.equal(answerTextForQuestion(textQuestion, { optionIds: [], text: '  hi  ' }), 'hi');
});

// --- askUserInputSchema 跨字段校验 ------------------------------------
test('🔴 askUserInputSchema 接受合法 choice 并拒绝无 options 的 choice', () => {
    assert.equal(
        askUserInputSchema.safeParse({
            questions: [
                {
                    question: 'q',
                    header: 'h',
                    type: 'choice',
                    options: [
                        { label: 'A', description: '' },
                        { label: 'B', description: '' },
                    ],
                },
            ],
        }).success,
        true,
    );
    assert.equal(
        askUserInputSchema.safeParse({ questions: [{ question: 'q', header: 'h', type: 'choice' }] }).success,
        false,
    );
});

test('🟠 askUserInputSchema 拒绝超过 HEADER_MAX_CHARS 的 header', () => {
    assert.equal(
        askUserInputSchema.safeParse({
            questions: [{ question: 'q', header: 'x'.repeat(HEADER_MAX_CHARS + 1), type: 'text' }],
        }).success,
        false,
    );
});

test('🟠 askUserInputSchema 限定 1..4 个问题', () => {
    assert.equal(askUserInputSchema.safeParse({ questions: [] }).success, false);
    const fiveQuestions = Array.from({ length: 5 }, () => ({ question: 'q', header: 'h', type: 'text' as const }));
    assert.equal(askUserInputSchema.safeParse({ questions: fiveQuestions }).success, false);
});

test('🟡 askUserInputSchema 限定 choice 题 2..4 个选项', () => {
    assert.equal(
        askUserInputSchema.safeParse({
            questions: [{ question: 'q', header: 'h', type: 'choice', options: [{ label: 'A', description: '' }] }],
        }).success,
        false,
    );
    const fiveOptions = Array.from({ length: 5 }, (_, index) => ({ label: 'O' + index, description: '' }));
    assert.equal(
        askUserInputSchema.safeParse({
            questions: [{ question: 'q', header: 'h', type: 'choice', options: fiveOptions }],
        }).success,
        false,
    );
});

// --- resume / request / output schema ---------------------------------
test('🟡 askUserResultSchema 将 optionIds 默认为空数组', () => {
    const parsed = askUserResultSchema.parse({ outcome: 'selected', answers: [{ questionId: 'q1' }] });
    assert.deepEqual(parsed.answers?.[0]?.optionIds, []);
});

test('🟡 askUserRequestSchema 要求 kind 与至少一个问题', () => {
    assert.equal(askUserRequestSchema.safeParse({ kind: 'user_question', questions: [] }).success, false);
    assert.equal(
        askUserRequestSchema.safeParse({
            kind: 'user_question',
            questions: [{ questionId: 'q1', question: 'q', header: 'h', type: 'text' }],
        }).success,
        true,
    );
});

test('🟡 askUserOutputSchema 将 answers 默认为空数组', () => {
    const parsed = askUserOutputSchema.parse({
        outcome: 'cancelled',
        display: 'x',
        dismissed: true,
        emptySubmission: true,
    });
    assert.deepEqual(parsed.answers, []);
});

// --- 工具装配面 --------------------------------------------------------
test('🟠 createAskUserTool 暴露 ask_user id 与 execute 入口', () => {
    const tool = createAskUserTool();
    assert.equal(tool.id, 'ask_user');
    assert.equal(typeof tool.execute, 'function');
});

test('🟡 createAskUserTools 以 ask_user 键注册工具', () => {
    assert.ok(createAskUserTools().ask_user);
});