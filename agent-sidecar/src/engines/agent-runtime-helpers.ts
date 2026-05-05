import type { IAgentStreamResult } from '../streaming/stream-runtime-contract.js';
import type {
    IAgentContextReferenceInput,
    IAgentRuntimeInput,
    TAgentMode,
} from './runtime-input.js';

const inferModelProviderLabel = (modelId: string): string => {
    const normalized = modelId.trim().toLowerCase();

    if (normalized.includes('deepseek')) {
        return 'DeepSeek';
    }

    if (normalized.startsWith('anthropic/') || normalized.includes('claude')) {
        return 'Anthropic';
    }

    if (normalized.startsWith('openai/') || normalized.startsWith('gpt-')) {
        return 'OpenAI';
    }

    if (normalized.startsWith('google/') || normalized.includes('gemini')) {
        return 'Google';
    }

    if (normalized.startsWith('qwen/') || normalized.includes('qwen')) {
        return '通义千问';
    }

    return '当前配置的 AI 服务平台';
};

const buildIdentityInstruction = (modelId: string): string => {
    const currentModel = modelId.trim() || '未指定';
    const provider = inferModelProviderLabel(currentModel);

    return `身份：你是Calamex桌面应用中的 AI 编程助手。当前模型：${currentModel}，平台：${provider}`;
};

const buildModeInstruction = (mode: TAgentMode): string => (mode === 'plan'
    ? [
        'Plan 模式要求：使用 structured output 返回 AgentPlan，不要输出 Markdown 或额外解释。',
        'steps 必须依据用户的真实任务制定，2 到 6 步，避免“分析/实现/测试”这类模板标题。',
        '每个 step 必须包含 id、title、goal、status、tools、riskLevel、requiresApproval、expectedOutput。',
        '如果使用 MCP 工具读取上下文，请先读取真实信息再生成计划。',
        '读和搜索是 low risk；写文件、删除、命令、安装依赖和 Git 操作至少是 medium risk 且 requiresApproval=true。',
    ].join('\n')
    : [
        'Agent 模式要求：按需调用工具或直接回答，不要先生成计划。',
        '如果当前没有可用工具执行，请明确说明缺失的运行条件，不要伪造成成功。',
    ].join('\n'));

const buildContextInstruction = (context: IAgentContextReferenceInput[] = []): string => {
    if (!context.length) {
        return '';
    }

    return [
        'UI 已提供上下文，必要时请结合这些内容判断任务：',
        ...context.map((reference, index) => [
            `#${index + 1} ${reference.label}`,
            `类型：${reference.kind}`,
            `路径：${reference.path ?? '无'}`,
            reference.range
                ? `范围：${reference.range.startLine}-${reference.range.endLine}`
                : '范围：无',
            `已脱敏：${reference.redacted ? '是' : '否'}`,
            '内容：',
            reference.contentPreview,
        ].join('\n')),
    ].join('\n\n');
};

export const buildSystemPrompt = (
    input: IAgentRuntimeInput,
    modelId = '未指定',
): string => {
    const systemMessages = input.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content.trim())
        .filter((content) => content.length > 0);
    const workspace = input.workspaceRootPath
        ? `workspaceRoot: ${input.workspaceRootPath}`
        : '';

    return [
        buildIdentityInstruction(modelId),
        buildModeInstruction(input.mode),
        workspace,
        buildContextInstruction(input.context),
        `goal: ${input.goal}`,
        systemMessages.length > 0 ? `system messages:\n${systemMessages.join('\n')}` : '',
    ]
        .filter((line) => line.trim().length > 0)
        .join('\n');
};

export const extractVisibleAgentResultText = (result: IAgentStreamResult): string => {
    const textParts: string[] = [];

    for (const block of result.lastMessage.content) {
        if (block.type === 'textBlock' && typeof block.text === 'string') {
            if (block.text.trim().length > 0) {
                textParts.push(block.text);
            }
        }
    }

    return textParts.join('').trim();
};