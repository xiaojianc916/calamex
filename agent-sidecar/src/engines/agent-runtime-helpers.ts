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
        '顶层可以包含 summary 和 requiresApproval；每个 step 必须包含 id、title、goal、status、tools、riskLevel、requiresApproval、expectedOutput。',
        'step 可补充 description、files、commands、risks、acceptanceCriteria，用于 UI 展示和执行验收。',
        'Plan 阶段只有只读工具，绝不能尝试写文件、运行命令、安装依赖或执行 Git 变更。',
        '如果使用 MCP 工具读取上下文，请先读取真实信息再生成计划。',
        '联网搜索必须优先使用 Tavily MCP 官方工具名：tavily-search 用于搜索，tavily-extract 用于读取网页内容，tavily-map / tavily-crawl 用于站点映射或抓取；不要在 Mastra sidecar 中生成旧的 web_search / web_fetch 伪工具名。',
        'Tavily 查询参数 query 请使用英文或中英混合自然语言；用户用中文提问时，先把检索词转成英文再调用 Tavily，最终回答仍使用中文。',
        '读和搜索是 low risk；写文件、删除、命令、安装依赖和 Git 操作至少是 medium risk 且 requiresApproval=true。',
    ].join('\n')
    : [
        'Agent 模式要求：按需调用工具或直接回答，不要先生成计划。',
        '一般知识问答、解释概念、翻译和写作请求应直接回答，不要为了“确认当前文件”而调用文件工具。',
        '只有用户明确要求读取、检查、修改项目文件，或 UI 上下文提供了相关路径且现有片段不足时，才按需读取文件。',
        '调用文件读取工具必须提供明确 path；没有路径时不要用空参数尝试读取“当前文件”，应基于已有上下文回答或请用户指定文件。',
        '联网搜索必须优先使用 Tavily MCP 官方工具：tavily-search、tavily-extract、tavily-map、tavily-crawl；不要调用旧的 web_search / web_fetch 伪工具名。',
        'Tavily 查询参数 query 请使用英文或中英混合自然语言；用户用中文提问时，先把检索词转成英文再调用 Tavily，最终回答仍使用中文。',
        '如果当前没有可用工具执行，请明确说明缺失的运行条件，不要伪造成成功。',
    ].join('\n'));

const buildContextInstruction = (context: IAgentContextReferenceInput[] = []): string => {
    const visibleContext = context.filter((reference) => reference.kind !== 'current-file');

    if (!visibleContext.length) {
        return '';
    }

    return [
        'UI 已提供上下文，必要时请结合这些内容判断任务；这些内容不代表必须读取完整文件：',
        ...visibleContext.map((reference, index) => [
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
