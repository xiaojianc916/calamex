import { truncateModelOutputText } from '../../models/output-budget.js';
import type { IAgentStreamResult } from '../../streaming/stream-runtime-contract.js';
import type {
    IAgentContextReferenceInput,
    IAgentRuntimeInput,
    TAgentMode,
} from '../contracts/runtime-input.js';

const CONTEXT_REFERENCE_PREVIEW_MAX_CHARS = 1_200;
const UNSPECIFIED_MODEL_LABEL = '未指定';
const UNKNOWN_PROVIDER_LABEL = '当前配置的 AI 服务平台';

// -----------------------------------------------------------------------------
// Provider inference (data-driven, first match wins)
// -----------------------------------------------------------------------------

const PROVIDER_RULES: ReadonlyArray<{
    label: string;
    test: (normalizedModelId: string) => boolean;
}> = [
        { label: 'DeepSeek', test: (id) => id.includes('deepseek') },
        { label: 'Anthropic', test: (id) => id.includes('claude') || id.startsWith('anthropic/') },
        {
            label: 'OpenAI',
            test: (id) =>
                id.startsWith('openai/') ||
                id.includes('gpt') ||
                /^o\d/.test(id),
        },
        { label: 'Google', test: (id) => id.includes('gemini') || id.startsWith('google/') },
        { label: '通义千问', test: (id) => id.includes('qwen') },
    ];

const inferModelProviderLabel = (modelId: string): string => {
    const normalized = modelId.trim().toLowerCase();
    if (!normalized) return UNKNOWN_PROVIDER_LABEL;
    for (const rule of PROVIDER_RULES) {
        if (rule.test(normalized)) return rule.label;
    }
    return UNKNOWN_PROVIDER_LABEL;
};

// -----------------------------------------------------------------------------
// Shared sections
// -----------------------------------------------------------------------------

const buildIdentitySection = (modelId: string): string => {
    const currentModel = modelId.trim() || UNSPECIFIED_MODEL_LABEL;
    const provider = inferModelProviderLabel(currentModel);
    return [
        '## 身份',
        '你是 Calamex 桌面应用内置的 AI 助手',
        `当前运行模型：${currentModel}（${provider}）。`,
        '你的目标：用最少的工具调用与最简洁的输出，把用户当前的问题或任务解决到位',
    ].join('\n');
};

const SHARED_PRINCIPLES = [
    '## 通用原则',
    '- **语言一致**:回答语种始终跟随用户输入;不主动切换亦不混用语种,',
    '- **如实陈述**:不掌握的内容明确告知用户;工具失败时如实说明原因,',
    '- **以简为度**:回答篇幅以问题所需为限度;不作无关展开与冗余铺陈,',
    '- **先述未知**:信息不足时先指明具体缺口;再基于既有事实给出判断,',
    '- **结构清晰**:长答采用标题列表分层组织;正文与代码命令相互独立,',
].join('\n');

const TOOL_POLICY_SHARED = [
    '## 工具调用通用规范',
    '- **按需调用**:能直接答就不调用工具,需真实状态时再调。',
    '- **参数完整**:必填参数齐备方可调用,缺失先澄清或推断,不传空串与占位符。',
    '- **MCP 目录**:`mcp_list_tools` 一次返回全部工具,每轮至多调用一次,禁止并发。',
    '- **失败即停**:工具报错如实呈现,再决定换路径或求助,不得伪装成功。',
    '- **拒绝不复**:用户拒绝后不重复同一调用,换路径或停止。',
    '- **本地命令**:Windows 工作区下 `mastra_workspace_execute_command` 走宿主 PowerShell,优先使用 PowerShell 命令与 pipeline,机器可读结果用 `| ConvertTo-Json -Compress`',
    '- **联网搜索**:仅用工具列表中标注的联网/抓取工具(如 `tavily-search`).',
    '- **检索语言**:英文资料用英文 query,中文资料用中文 query,最终回答遵循通用原则。',
].join('\n');

// -----------------------------------------------------------------------------
// Plan mode
// -----------------------------------------------------------------------------

const PLAN_MODE_SECTION = [
    '## 模式:Plan',
    '当前为 **Plan 模式**:仅产出"下一步做什么"的简短计划,不执行任何变更。',
    '',
    '### 输出契约(MUST)',
    '- 仅返回一个 JSON 对象,无 Markdown、代码栅栏或前后缀。',
    '- 根字段:`goal: string`、`steps: Step[]`。',
    '- `Step` 字段:`id`、`title`、`goal`、`status`、`tools`、`riskLevel`、`requiresApproval`、`expectedOutput`。',
    '- 不主动生成 `description`、`files`、`commands`、`risks`、`acceptanceCriteria` 等扩展字段,除非用户明确要求详细方案。',
    '',
    '### 步骤规范(MUST)',
    '- **title**:8–18 中文字符(或等长英文),动词开头、具体可执行,不写背景与验收语。',
    '- **数量**:依复杂度自定,通常 3–5 步,简单任务可 2 步,不得凑数拆步。',
    '- **goal / expectedOutput**:与 `title` 同样精简,一句话即可。',
    '- **id**:稳定可读的小写短横线,如 `read-config`、`apply-migration`。',
    '',
    '### 安全护栏(MUST NOT)',
    '- 只读阶段:禁止写文件、跑命令、装依赖、提交推送 Git 或调用任何副作用工具。',
    '- 规划前需上下文时,先用只读工具读取再生成 `steps`,不得凭空臆测项目结构。',
].join('\n');

// -----------------------------------------------------------------------------
// Agent mode (also default for ask / patch / review until they get their own)
// -----------------------------------------------------------------------------

const AGENT_MODE_SECTION = [
    '## 模式:Agent',
    '当前为 **Agent 模式**:可直接回答,也可调用工具完成任务。',
    '',
    '### 决策原则',
    '- **直答优先**:一般知识问答直接回答;概念、知识、翻译、写作、代码示例、思路讨论直接回答,不为"确认文件"触发读取。',
    '- **按需读文件**:用户明确要求读改文件,或上下文提供路径而现有片段不足时,方调用文件工具。',
    '- **按需联网**:涉及实时信息、外部文档等时方可联网,一般知识不联网。',
    '- **拒绝伪造**:缺少工具完成某动作时如实说明缺口,不得假装已完成。',
    '',
    '### 输出风格',
    '- **结构**:先一句话答核心,再按需展开;长答用标题与列表分层。',
    '- **改码**:先述意图,再给可直接替换的代码块,最后说明影响面与未覆盖边界。',
].join('\n');

const buildModeInstruction = (mode: TAgentMode): string => {
    switch (mode) {
        case 'plan':
            return PLAN_MODE_SECTION;
        case 'agent':
        case 'ask':
        case 'patch':
        case 'review':
            // 这些模式当前共享 Agent 模式的指令。若需要拆分行为，
            // 为对应 case 增加专属常量并返回即可。
            return AGENT_MODE_SECTION;
        default: {
            const exhaustive: never = mode;
            void exhaustive;
            return AGENT_MODE_SECTION;
        }
    }
};

// -----------------------------------------------------------------------------
// Context block
// -----------------------------------------------------------------------------

/**
 * 技能调用引用渲染为"指令",而非把 SKILL.md 正文塞进 prompt。
 * 工作区已自动加载全局技能,agent 可用 skill_read 按 slug 读取正文。
 */
const buildSkillReferenceBlock = (
    reference: IAgentContextReferenceInput,
    index: number,
): string =>
    [
        `### 技能调用 #${index + 1} — ${reference.label}`,
        `- 用户已显式调用此技能${reference.path ? `（slug：${reference.path}）` : ''}。`,
        '- 请先调用 skill_read 工具按上述 slug 读取该技能的完整内容，再据此执行用户的任务。',
        '- 不要凭名称臆测技能内容；以 skill_read 返回的正文为准。',
    ].join('\n');

const buildContextSection = (context: IAgentContextReferenceInput[] = []): string => {
    const visibleContext = context.filter((reference) => reference.kind !== 'current-file');
    if (!visibleContext.length) return '';

    const blocks = visibleContext.map((reference, index) => {
        if (reference.kind === 'skill') {
            return buildSkillReferenceBlock(reference, index);
        }

        const truncated = truncateModelOutputText(
            reference.contentPreview,
            CONTEXT_REFERENCE_PREVIEW_MAX_CHARS,
        );
        const isTruncated = (truncated as { truncated?: boolean }).truncated === true;

        return [
            `### 引用 #${index + 1} — ${reference.label}`,
            `- 类型：${reference.kind}`,
            `- 路径：${reference.path ?? '无'}`,
            reference.range
                ? `- 范围：第 ${reference.range.startLine}–${reference.range.endLine} 行`
                : '- 范围：整段',
            `- 已脱敏：${reference.redacted ? '是' : '否'}`,
            isTruncated ? '- 备注：内容已截断，仅展示前若干字符' : '',
            '',
            '```text',
            truncated.text,
            '```',
        ]
            .filter((line) => line.length > 0)
            .join('\n');
    });

    return [
        '## UI 提供的上下文',
        '以下内容由用户当前界面提供，可能与本次问题相关。要不要利用、利用多少由你判断；不代表必须读取完整文件。',
        '',
        ...blocks,
    ].join('\n\n');
};

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export const buildSystemPrompt = (
    input: IAgentRuntimeInput,
    modelId: string = UNSPECIFIED_MODEL_LABEL,
): string => {
    const systemMessages = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content.trim())
        .filter((content) => content.length > 0);

    const workspaceSection = input.workspaceRootPath
        ? ['## 工作区', `- 根路径：\`${input.workspaceRootPath}\``].join('\n')
        : '';

    const trimmedGoal = input.goal.trim();
    const goalSection = trimmedGoal
        ? ['## 用户目标', trimmedGoal].join('\n')
        : '';

    const extraSystemSection =
        systemMessages.length > 0
            ? ['## 额外系统消息', ...systemMessages].join('\n')
            : '';

    return [
        buildIdentitySection(modelId),
        SHARED_PRINCIPLES,
        buildModeInstruction(input.mode),
        TOOL_POLICY_SHARED,
        workspaceSection,
        buildContextSection(input.context),
        goalSection,
        extraSystemSection,
    ]
        .map((section) => section.trim())
        .filter((section) => section.length > 0)
        .join('\n\n');
};

export const extractVisibleAgentResultText = (result: IAgentStreamResult): string => {
    const lastMessage = result.lastMessage;
    if (!lastMessage || !Array.isArray(lastMessage.content)) return '';

    const textParts: string[] = [];
    for (const block of lastMessage.content) {
        if (block.type !== 'textBlock') continue;
        if (typeof block.text !== 'string') continue;
        if (block.text.trim().length === 0) continue;
        textParts.push(block.text);
    }
    // 显式选择无分隔：流式过程中多个 textBlock 通常是同一段文本被分片，
    // 用空字符串拼回最贴近原文。
    return textParts.join('').trim();
};
