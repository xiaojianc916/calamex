<script setup lang="ts">
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Globe,
  Network,
  Paintbrush,
  Paperclip,
  Plus,
  Route,
  Settings2,
  Square,
} from '@lucide/vue';
import { computed, onMounted, ref, useAttrs, watch } from 'vue';
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
} from '@/components/ai-elements/context';
import { PromptInputAttachmentsDisplay } from '@/components/ai-elements/prompt-input';
import { collectConnectedPlatformIds } from '@/components/business/ai/chat/connected-platforms';
import AiProviderIcon from '@/components/business/ai/provider/AiProviderIcon.vue';
import {
  computeDeepSeekCostBreakdown,
  formatCnyCost,
} from '@/components/business/ai/provider/deepseek-pricing';
import { AiSlashCommandMenu, SkillManagerDialog } from '@/components/business/ai/skill';
import DropdownMenu from '@/components/ui/dropdown-menu/DropdownMenu.vue';
import DropdownMenuContent from '@/components/ui/dropdown-menu/DropdownMenuContent.vue';
import DropdownMenuItem from '@/components/ui/dropdown-menu/DropdownMenuItem.vue';
import DropdownMenuSub from '@/components/ui/dropdown-menu/DropdownMenuSub.vue';
import DropdownMenuSubContent from '@/components/ui/dropdown-menu/DropdownMenuSubContent.vue';
import DropdownMenuSubTrigger from '@/components/ui/dropdown-menu/DropdownMenuSubTrigger.vue';
import DropdownMenuTrigger from '@/components/ui/dropdown-menu/DropdownMenuTrigger.vue';
import { InputGroup, InputGroupAddon, InputGroupButton } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import type { IAiTokenContextProps } from '@/composables/ai/useAiTokenContext';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import {
  AI_SERVICE_PLATFORM_PRESETS,
  findAiServicePlatformByModel,
} from '@/constants/ai/providers';
import { skillsTauriService } from '@/services/tauri.skills';
import type { IAiAttachedFile, IAiConfigPayload, TAiAgentNetworkPermission } from '@/types/ai';
import { isAiAssistantMode, type TAiAssistantMode } from '@/types/ai/assistant-mode';
import type { TAiExecutionMode } from '@/types/ai/execution-mode';
import type { ISelectedSkill, ISkillSummary } from '@/types/ai/skill';
import AiErrorNotice from './AiErrorNotice.vue';
import { pickAttachmentFilesViaNativeDialog } from './attachment-file-picker';

interface IAiPromptModeOption {
  key: TAiAssistantMode;
  label: string;
}

interface IAiPromptModelOption {
  id: string;
  label: string;
}

interface IAiPromptModelSection {
  key: TAiServicePlatformId;
  label: string;
  badge: string | null;
  models: IAiPromptModelOption[];
}

interface ISlashAnchorRect {
  left: number;
  top: number;
  width: number;
}

/**
 * 当前会话可用的 Agent 后端：
 * - builtin：本应用自研 Agent（默认）。
 * - kimi：Moonshot Kimi（月之暗面）外部 Agent CLI。
 * 一个会话只使用一种 Agent。
 */
type TAiPromptAgentKind = 'builtin' | 'kimi';

/** 输入框纯文本（不含技能胶囊） */
const modelValue = defineModel<string>({ required: true });

/** 当前模式（双向绑定） */
const activeMode = defineModel<TAiAssistantMode>('activeMode', { required: true });

/** 已选中的技能胶囊（内联显示在输入框中，独立于纯文本） */
const selectedSkills = defineModel<ISelectedSkill[]>('selectedSkills', {
  default: () => [],
});

/**
 * 当前会话使用的 Agent 后端（自研 / Kimi）。
 * 默认 builtin；父级未绑定时仍可独立工作（用于先把 UI 做上）。
 */
const selectedAgent = defineModel<TAiPromptAgentKind>('agentBackend', {
  default: 'kimi',
});

// Kimi Code 当前选中的内置模式（普通 / Plan / Auto / YOLO），与 builtin 的 activeMode 解耦。
const kimiMode = defineModel<string>('kimiMode', { default: 'normal' });

const props = defineProps<{
  disabled: boolean;
  stopVisible?: boolean;
  errorMessage: string;
  submitLabel: string;
  attachments: readonly IAiAttachedFile[];
  hasAttachments: boolean;
  tokenContext?: IAiTokenContextProps;
  config: IAiConfigPayload;
  /**
   * 当前 Agent 的会话级模型覆盖值。父级按 Agent 维护各自的模型记忆并下传；
   * 为空（undefined / 空串）时回退到 props.config.selectedModel（全局 / 当前选中模型）。
   * 让模型选择器在不同 Agent 间互不串用，同时完全复用既有 UI。
   */
  selectedModelOverride?: string;
  isModelSaving?: boolean;
  networkPermission: TAiAgentNetworkPermission;
  isNetworkPermissionSaving?: boolean;
  executionMode: TAiExecutionMode;
  resolveAttachment: (file: File) => Promise<boolean>;
  /**
   * 工作区根目录绝对路径（可选）。用于首次使用原生附件选择器时，
   * 在没有“上次目录”记忆的情况下回退到工作区根目录。父级未下传时优雅降级。
   */
  workspaceRootPath?: string | null;
}>();

const emit = defineEmits<{
  submit: [];
  stop: [];
  removeFile: [id: string];
  modelChange: [modelId: string];
  networkPermissionChange: [permission: TAiAgentNetworkPermission];
  executionModeChange: [mode: TAiExecutionMode];
  informationSourcesOpen: [];
  personalizationOpen: [];
  prewarm: [];
}>();

const attrs = useAttrs();
const surfaceRef = ref<HTMLFormElement | null>(null);
const editorRef = ref<HTMLDivElement | null>(null);
const isComposing = ref(false);
const pendingAttachmentDrafts = ref<IAiAttachedFile[]>([]);

// 编辑器内容程序化写入时为 true，避免输入事件回环。
let isApplyingExternalValue = false;

// 技能 / 斜杠菜单状态。
const skills = ref<ISkillSummary[]>([]);
const slashOpen = ref(false);
const slashQuery = ref('');
const slashAnchorRect = ref<ISlashAnchorRect | null>(null);
const skillsManagerOpen = ref(false);
let skillsLoadPromise: Promise<void> | null = null;

const modeOptions: IAiPromptModeOption[] = [
  { key: 'chat', label: 'chat' },
  { key: 'agent', label: 'agent' },
  { key: 'plan', label: 'plan' },
];

// Kimi Code 官方内置模式（固定集合，非 ACP 动态公示）。
const KIMI_MODES: { key: string; label: string }[] = [
  { key: 'default', label: 'Default' },
  { key: 'plan', label: 'Plan' },
  { key: 'auto', label: 'Auto' },
  { key: 'yolo', label: 'YOLO' },
];

const emptyTokenContext: IAiTokenContextProps = {
  usedTokens: 0,
  maxTokens: 0,
  usageSource: 'estimated',
  usage: {
    inputTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 0,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  },
};

const resolvedTokenContext = computed(() => props.tokenContext ?? emptyTokenContext);

const formatModelLabel = (label: string): string =>
  label
    .replace(/^Claude\s+/u, '')
    .replace(/^GPT5/u, 'GPT-5')
    .replace(/^DeepSeek-v/u, 'DeepSeek V')
    .replace(/^Kimi-k/u, 'Kimi K')
    .replace(/^gemini-/u, 'Gemini ')
    .replace(/-preview$/u, '')
    .replace(/-/gu, ' ')
    .replace(/\bpro\b/giu, 'Pro')
    .replace(/\bflash\b/giu, 'Flash')
    .replace(/\s+/gu, ' ')
    .trim();

const selectedModel = computed(() => {
  const overridden = props.selectedModelOverride?.trim();
  if (overridden) {
    return overridden;
  }
  return props.config.selectedModel?.trim() ?? '';
});

const tokenUsageCost = computed(() => {
  const pricing = computeDeepSeekCostBreakdown(
    selectedModel.value,
    resolvedTokenContext.value.usage,
  );
  if (!pricing) {
    return undefined;
  }
  return {
    inputCostText: formatCnyCost(pricing.inputCostCny),
    outputCostText: formatCnyCost(pricing.outputCostCny),
    totalCostText: formatCnyCost(pricing.totalCostCny),
    cacheHitInputCostText: formatCnyCost(pricing.cacheHitInputCostCny),
    cacheMissInputCostText: formatCnyCost(pricing.cacheMissInputCostCny),
    cacheHitInputTokens: pricing.usage.cacheHitInputTokens,
    cacheMissInputTokens: pricing.usage.cacheMissInputTokens,
  };
});

const selectedPlatform = computed(() => findAiServicePlatformByModel(selectedModel.value));

const selectedModelLabel = computed(() => {
  const modelId = selectedModel.value;
  if (!modelId) {
    return '未选择模型';
  }
  const matched = selectedPlatform.value.models.find((model) => model.id === modelId);
  if (matched) {
    return formatModelLabel(matched.label);
  }
  return formatModelLabel(modelId.split('/').filter(Boolean).at(-1) ?? modelId);
});

const selectedPlatformId = computed<TAiServicePlatformId>(() => selectedPlatform.value.id);

const connectedPlatformIds = computed(() => collectConnectedPlatformIds(props.config.credentials));

const modelSections = computed<IAiPromptModelSection[]>(() =>
  AI_SERVICE_PLATFORM_PRESETS.map((platform) => ({
    key: platform.id,
    label: platform.label,
    badge: connectedPlatformIds.value.has(platform.id) ? '已接入' : null,
    models: platform.models.map((model) => ({
      id: model.id,
      label: formatModelLabel(model.label),
    })),
  })).filter((section) => section.models.length > 0),
);

const hasProcessingAttachments = computed(
  () =>
    pendingAttachmentDrafts.value.some((attachment) => attachment.status === 'processing') ||
    props.attachments.some((attachment) => attachment.status === 'processing'),
);

const hasReadyAttachments = computed(() =>
  props.attachments.some((attachment) => (attachment.status ?? 'ready') === 'ready'),
);

const displayedAttachments = computed<readonly IAiAttachedFile[]>(() => [
  ...pendingAttachmentDrafts.value,
  ...props.attachments,
]);

const canSubmit = computed(
  () =>
    (modelValue.value.trim().length > 0 || hasReadyAttachments.value) &&
    !hasProcessingAttachments.value,
);

const isEditorEmpty = computed(
  () => (modelValue.value?.trim().length ?? 0) === 0 && (selectedSkills.value?.length ?? 0) === 0,
);

const modelSelectDisabled = computed(() => props.disabled || props.isModelSaving);

const networkPermissionEnabled = computed(() => props.networkPermission === 'allowed-this-run');

// 执行自主性:autonomous = 开启「自主 plan 模式」(批准后无人值守闭环);
// 默认 interactive = 逐步门控。对标 Cline Auto-approve / Cursor Auto-run。
const executionAutonomous = computed(() => props.executionMode === 'autonomous');

// 模式选择器（统一实现）：按当前 Agent 决定可选模式集。
// - builtin：执行模式 chat / agent / plan，绑定 activeMode（驱动既有发送路由）。
// - kimi：Kimi 官方内置模式 普通 / Plan / Auto / YOLO，绑定 kimiMode（静态表，非 ACP 动态）。
const modeSelectItems = computed<{ key: string; label: string }[]>(() =>
  selectedAgent.value === 'kimi' ? KIMI_MODES : modeOptions,
);

// 当前模式 key：若原始值（如 kimiMode 默认 'normal'）不在可选集中，回退到首项，
// 保证子菜单入口文案与勾选状态始终有效、不为空。
const modeSelectValue = computed(() => {
  const raw = selectedAgent.value === 'kimi' ? kimiMode.value : activeMode.value;
  const items = modeSelectItems.value;
  return items.some((mode) => mode.key === raw) ? raw : (items[0]?.key ?? raw);
});

const handleModeSelect = (value: unknown): void => {
  if (typeof value !== 'string' || !value.trim()) {
    return;
  }
  if (selectedAgent.value === 'kimi') {
    kimiMode.value = value;
    return;
  }
  handleModeChange(value);
};

// 二级菜单入口左侧展示的当前模式文案。
const modeSelectValueLabel = computed(() => {
  const current = modeSelectItems.value.find((mode) => mode.key === modeSelectValue.value);
  return current?.label ?? '';
});

const networkPermissionLabel = computed(() => (networkPermissionEnabled.value ? '已允许' : '询问'));

const executionModeLabel = computed(() => (executionAutonomous.value ? '已开启' : '已关闭'));

const normalizePendingAttachmentName = (file: File): string => {
  const normalizedName = file.name.trim();
  if (normalizedName) {
    return normalizedName;
  }
  return file.type.startsWith('image/') ? 'pasted-image' : 'pasted-attachment';
};

const createPendingAttachment = (file: File): IAiAttachedFile => {
  const name = normalizePendingAttachmentName(file);
  const kind = file.type.startsWith('image/') ? 'image' : 'text';
  const id = `pending-attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name,
    sizeLabel: '',
    kind,
    status: 'processing',
    detailLabel: '处理中…',
    reference: {
      id,
      kind: kind === 'image' ? 'image-attachment' : 'search-result',
      label: `${kind === 'image' ? '图片附件' : '附件'} · ${name}`,
      path: name,
      range: null,
      contentPreview: '附件正在处理中，完成后会作为 AI 上下文发送。',
      redacted: false,
    },
  };
};

const queueAttachmentFile = async (file: File): Promise<void> => {
  const draft = createPendingAttachment(file);
  pendingAttachmentDrafts.value = [...pendingAttachmentDrafts.value, draft];
  let resolved = false;
  try {
    resolved = await props.resolveAttachment(file);
  } catch {
    resolved = false;
  }
  if (resolved) {
    pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.filter(
      (attachment) => attachment.id !== draft.id,
    );
    return;
  }
  pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.map((attachment) =>
    attachment.id === draft.id
      ? { ...attachment, status: 'failed', detailLabel: '处理失败' }
      : attachment,
  );
};

// -------------------------------------------------------------------------
// 富文本输入：纯文本 + 内联技能胶囊
// -------------------------------------------------------------------------
const PILL_SELECTOR = '[data-skill-pill]';
const BLOCK_TAGS = new Set(['DIV', 'P']);

const skillsEqual = (
  left: readonly ISelectedSkill[],
  right: readonly ISelectedSkill[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((skill, index) => skill.slug === right[index]?.slug);
};

const serializeEditorNode = (node: Node, ctx: { text: string; skills: ISelectedSkill[] }): void => {
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      ctx.text += child.nodeValue ?? '';
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = child as HTMLElement;
    if (element.matches(PILL_SELECTOR)) {
      const slug = element.dataset.skillSlug ?? '';
      if (slug) {
        ctx.skills.push({ slug, name: element.dataset.skillName ?? '' });
      }
      return;
    }
    if (element.tagName === 'BR') {
      ctx.text += '\n';
      return;
    }
    if (BLOCK_TAGS.has(element.tagName) && ctx.text.length > 0 && !ctx.text.endsWith('\n')) {
      ctx.text += '\n';
    }
    serializeEditorNode(element, ctx);
  });
};

const serializeEditor = (): { text: string; skills: ISelectedSkill[] } => {
  const root = editorRef.value;
  if (!root) {
    return { text: modelValue.value ?? '', skills: [...(selectedSkills.value ?? [])] };
  }
  const ctx = { text: '', skills: [] as ISelectedSkill[] };
  serializeEditorNode(root, ctx);
  return ctx;
};

const createPillElement = (skill: ISelectedSkill): HTMLSpanElement => {
  const pill = document.createElement('span');
  pill.className = 'ai-skill-pill';
  pill.dataset.skillPill = '';
  pill.dataset.skillSlug = skill.slug;
  pill.dataset.skillName = skill.name;
  pill.setAttribute('contenteditable', 'false');

  const icon = document.createElement('span');
  icon.className = 'ai-skill-pill__icon';
  icon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>';
  icon.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'ai-skill-pill__label';
  label.textContent = skill.name || skill.slug;

  pill.append(icon, label);
  return pill;
};

const applyValueToEditor = (text: string, skills: readonly ISelectedSkill[]): void => {
  const root = editorRef.value;
  if (!root) {
    return;
  }
  isApplyingExternalValue = true;
  root.replaceChildren();
  skills.forEach((skill) => {
    root.append(createPillElement(skill), document.createTextNode(' '));
  });
  if (text) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) {
        root.append(document.createElement('br'));
      }
      if (line) {
        root.append(document.createTextNode(line));
      }
    });
  }
  isApplyingExternalValue = false;
};

const getEditorSelectionRange = (): Range | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const root = editorRef.value;
  if (!root?.contains(range.startContainer)) {
    return null;
  }
  return range;
};

const getSlashQueryAtCaret = (): string | null => {
  const range = getEditorSelectionRange();
  if (!range?.collapsed) {
    return null;
  }
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const textBefore = (node.nodeValue ?? '').slice(0, range.startOffset);
  const match = /(?:^|\s)\/(\S*)$/.exec(textBefore);
  return match ? match[1] : null;
};

const ensureSkillsLoaded = (): Promise<void> => {
  if (skills.value.length > 0) {
    return Promise.resolve();
  }

  skillsLoadPromise ??= loadSkills().finally(() => {
    skillsLoadPromise = null;
  });
  return skillsLoadPromise;
};

const updateSlashStateFromCaret = (): void => {
  const query = getSlashQueryAtCaret();
  if (query !== null) {
    slashQuery.value = query;
    if (!slashOpen.value) {
      void ensureSkillsLoaded();
    }
    refreshSlashAnchorRect();
    slashOpen.value = true;
    return;
  }
  if (slashOpen.value) {
    closeSlashMenu();
  }
};

const syncFromEditor = (): void => {
  if (isApplyingExternalValue) {
    return;
  }

  const { text, skills } = serializeEditor();

  if (modelValue.value !== text) {
    modelValue.value = text;
  }

  if (!skillsEqual(selectedSkills.value ?? [], skills)) {
    selectedSkills.value = skills;
  }
};

const onEditorInput = (): void => {
  if (isApplyingExternalValue) {
    return;
  }
  syncFromEditor();
  updateSlashStateFromCaret();
};

const onCompositionEnd = (): void => {
  isComposing.value = false;
  syncFromEditor();
  updateSlashStateFromCaret();
};

const insertSkillPill = (skill: ISelectedSkill): void => {
  const root = editorRef.value;
  if (!root) {
    return;
  }
  root.focus();
  const range = getEditorSelectionRange();
  const alreadySelected = (selectedSkills.value ?? []).some((item) => item.slug === skill.slug);

  if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
    const node = range.startContainer as Text;
    const value = node.nodeValue ?? '';
    const before = value.slice(0, range.startOffset);
    const after = value.slice(range.startOffset);
    const match = /(^|\s)(\/\S*)$/.exec(before);
    if (match) {
      const keepBefore = before.slice(0, before.length - match[2].length);
      node.nodeValue = keepBefore + after;
      range.setStart(node, keepBefore.length);
      range.collapse(true);
    }
  }

  let insertionRange = getEditorSelectionRange();
  if (!insertionRange) {
    insertionRange = document.createRange();
    insertionRange.selectNodeContents(root);
    insertionRange.collapse(false);
  }

  if (!alreadySelected) {
    const pill = createPillElement(skill);
    const trailingSpace = document.createTextNode(' ');
    insertionRange.insertNode(trailingSpace);
    insertionRange.insertNode(pill);
    insertionRange.setStartAfter(trailingSpace);
    insertionRange.collapse(true);
  }

  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(insertionRange);
  }
  closeSlashMenu();
  syncFromEditor();
};

const insertLineBreakAtCaret = (): void => {
  document.execCommand('insertLineBreak');
  syncFromEditor();
};

// -------------------------------------------------------------------------
// 技能 / 斜杠菜单
// -------------------------------------------------------------------------
const loadSkills = async (): Promise<void> => {
  try {
    const result = await skillsTauriService.listSkills();
    skills.value = [...result.skills];
  } catch {
    skills.value = [];
  }
};

const refreshSlashAnchorRect = (): void => {
  const element = surfaceRef.value;
  if (!element) {
    slashAnchorRect.value = null;
    return;
  }
  const rect = element.getBoundingClientRect();
  slashAnchorRect.value = { left: rect.left, top: rect.top, width: rect.width };
};

const closeSlashMenu = (): void => {
  slashOpen.value = false;
};

const openSkillsManager = (): void => {
  closeSlashMenu();
  void ensureSkillsLoaded();
  skillsManagerOpen.value = true;
};

// 选择技能：在光标处插入胶囊并去重，技能本身随 selectedSkills 上抩由发送时附加指令。
const handleSelectSkill = (slug: string): void => {
  const summary = skills.value.find((item) => item.slug === slug);
  const name = summary?.name?.trim() || slug;
  insertSkillPill({ slug, name });
};

const handleSubmit = (): void => {
  syncFromEditor();

  if (props.disabled || !canSubmit.value) {
    return;
  }

  emit('submit');
};

const handleModeChange = (value: unknown): void => {
  if (!isAiAssistantMode(value)) {
    return;
  }
  activeMode.value = value;
};

const handleModelChange = (value: unknown): void => {
  if (typeof value !== 'string' || !value.trim()) {
    return;
  }
  if (value === selectedModel.value) {
    return;
  }
  emit('modelChange', value);
};

const toggleNetworkPermission = (): void => {
  if (props.disabled || props.isNetworkPermissionSaving) {
    return;
  }
  emit('networkPermissionChange', networkPermissionEnabled.value ? 'ask' : 'allowed-this-run');
};

// 切换自主 plan 模式:interactive(逐步门控) ⇄ autonomous(无人值守闭环)。
// executionMode 是本地同步状态,无需 saving 态。
const toggleExecutionMode = (): void => {
  if (props.disabled) {
    return;
  }
  emit('executionModeChange', executionAutonomous.value ? 'interactive' : 'autonomous');
};

const handleOpenInformationSources = (): void => {
  emit('informationSourcesOpen');
};

const handleOpenPersonalization = (): void => {
  emit('personalizationOpen');
};

const handlePrewarmIntent = (): void => {
  emit('prewarm');
};

const handleRemoveAttachment = (id: string): void => {
  if (pendingAttachmentDrafts.value.some((attachment) => attachment.id === id)) {
    pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.filter(
      (attachment) => attachment.id !== id,
    );
    return;
  }
  emit('removeFile', id);
};

// 📎 附件选择：调用系统原生文件对话框（记忆上次目录、首次回退工作区根 / home）。
// 仅桌面运行时可用；已移除向隐藏 <input type=file> 的降级。
const handleOpenFileDialog = async (): Promise<void> => {
  if (props.disabled) {
    return;
  }
  try {
    const files = await pickAttachmentFilesViaNativeDialog({
      workspaceRootPath: props.workspaceRootPath,
    });
    for (const file of files) {
      void queueAttachmentFile(file);
    }
  } catch {
    // 原生运行时不可用时静默忽略（不再回退到浏览器 <input>）。
  }
};

const handlePaste = (event: ClipboardEvent): void => {
  const items = event.clipboardData?.items;
  if (items) {
    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        pastedFiles.push(file);
      }
    }
    if (pastedFiles.length) {
      event.preventDefault();
      for (const file of pastedFiles) {
        void queueAttachmentFile(file);
      }
      return;
    }
  }
  // 纯文本粘贴：以 plain text 插入，避免把富文本 / 胶囊结构带进编辑器。
  const text = event.clipboardData?.getData('text/plain');
  if (text) {
    event.preventDefault();
    document.execCommand('insertText', false, text);
    syncFromEditor();
    updateSlashStateFromCaret();
  }
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter') {
    return;
  }
  if (event.shiftKey) {
    event.preventDefault();
    insertLineBreakAtCaret();
    return;
  }
  if (isComposing.value || event.isComposing) {
    return;
  }
  event.preventDefault();
  if (props.disabled) {
    return;
  }
  handleSubmit();
};

const handleStop = (): void => {
  emit('stop');
};

// 外部写入 modelValue / selectedSkills（如填充建议、发送后清空）时同步重建编辑器内容。
// 用户输入触发的更新会与序列化结果一致，从而跳过重建、保住光标。
watch(
  [modelValue, selectedSkills],
  () => {
    if (isApplyingExternalValue) {
      return;
    }
    const root = editorRef.value;
    if (!root) {
      return;
    }
    const current = serializeEditor();
    if (
      current.text === (modelValue.value ?? '') &&
      skillsEqual(current.skills, selectedSkills.value ?? [])
    ) {
      return;
    }
    applyValueToEditor(modelValue.value ?? '', selectedSkills.value ?? []);
  },
  { flush: 'post' },
);

onMounted(() => {
  applyValueToEditor(modelValue.value ?? '', selectedSkills.value ?? []);
});
</script>

<template>
  <footer class="ai-composer">
    <form ref="surfaceRef" class="ai-composer-surface" v-bind="attrs" @submit.prevent="handleSubmit">
      <div v-if="displayedAttachments.length" class="ai-attachments">
        <PromptInputAttachmentsDisplay
          :attachments="displayedAttachments"
          @remove="handleRemoveAttachment"
        />
      </div>
      <AiErrorNotice :message="errorMessage" />
      <InputGroup class="ai-prompt-shell">
        <div class="ai-prompt-editor-wrap">
          <div
            ref="editorRef"
            class="ai-prompt-textarea ai-prompt-editor"
            data-slot="ai-prompt-editor"
            role="textbox"
            aria-multiline="true"
            aria-label="输入消息"
            :contenteditable="disabled ? 'false' : 'true'"
            @input="onEditorInput"
            @keydown="handleKeyDown"
            @paste="handlePaste"
            @contextmenu.prevent
            @focus="handlePrewarmIntent"
            @mouseenter="handlePrewarmIntent"
            @compositionstart="isComposing = true"
            @compositionend="onCompositionEnd"
          ></div>
          <span
            v-if="isEditorEmpty"
            class="ai-prompt-placeholder"
            aria-hidden="true"
            >使用 AI 处理各种任务...</span
          >
        </div>
        <InputGroupAddon align="block-end" class="ai-toolbar-row">
          <div class="ai-toolbar-left">
            <InputGroupButton
              type="button"
              variant="ghost"
              class="ai-icon-action ai-attachment-button"
              size="icon-xs"
              :disabled="disabled"
              aria-label="提供背景信息"
              @click="handleOpenFileDialog"
            >
              <Paperclip class="size-4" :stroke-width="1.5" />
            </InputGroupButton>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <InputGroupButton
                  type="button"
                  variant="ghost"
                  class="ai-icon-action ai-mode-trigger"
                  size="icon-xs"
                  :disabled="disabled"
                  aria-label="打开 AI 模式设置"
                >
                  <Settings2 class="size-4" :stroke-width="1.5" />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                :side-offset="8"
                class="ai-settings-menu"
              >
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger class="ai-settings-menu-item ai-settings-submenu-trigger">
                    <Route class="ai-settings-menu-icon" />
                    <span class="ai-settings-menu-label" v-text="modeSelectValueLabel"></span>
                    <ChevronRight class="ai-settings-menu-chevron" />
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent
                    :side-offset="4"
                    class="ai-settings-submenu"
                  >
                    <DropdownMenuItem
                      v-for="mode in modeSelectItems"
                      :key="mode.key"
                      class="ai-settings-menu-item ai-settings-mode-item"
                      :data-active="modeSelectValue === mode.key ? '' : undefined"
                      @select.prevent="handleModeSelect(mode.key)"
                    >
                      <span class="ai-settings-menu-label" v-text="mode.label"></span>
                      <Check v-if="modeSelectValue === mode.key" class="ai-settings-menu-check" />
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <div class="ai-settings-menu-separator" aria-hidden="true"></div>
                <DropdownMenuItem
                  class="ai-settings-menu-item"
                  :disabled="disabled"
                  @select.prevent="toggleNetworkPermission"
                >
                  <Globe class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">网络访问权限</span>
                  <button
                    type="button"
                    class="ai-network-switch"
                    @pointerdown.prevent
                    :class="{ 'is-on': networkPermissionEnabled }"
                    :aria-pressed="networkPermissionEnabled"
                    tabindex="-1"
                  >
                    <span class="ai-network-switch__thumb" aria-hidden="true"></span>
                    <span class="sr-only" v-text="networkPermissionLabel"></span>
                  </button>
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="ai-settings-menu-item"
                  @select="handleOpenInformationSources"
                >
                  <Network class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">我的信息源</span>
                  <ChevronRight class="ai-settings-menu-chevron" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="ai-settings-menu-item"
                  @select="openSkillsManager"
                >
                  <Plus class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">添加skill</span>
                </DropdownMenuItem>

                <DropdownMenuItem
                  v-if="selectedAgent === 'builtin' && activeMode === 'plan'"
                  class="ai-settings-menu-item"
                  :disabled="disabled"
                  @select.prevent="toggleExecutionMode"
                >
                  <Bot class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">自主plan模式</span>
                  <button
                    type="button"
                    class="ai-network-switch"
                    @pointerdown.prevent
                    :class="{ 'is-on': executionAutonomous }"
                    :aria-pressed="executionAutonomous"
                    tabindex="-1"
                  >
                    <span class="ai-network-switch__thumb" aria-hidden="true"></span>
                    <span class="sr-only" v-text="executionModeLabel"></span>
                  </button>
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="ai-settings-menu-item"
                  @select="handleOpenPersonalization"
                >
                  <Paintbrush class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">个性化</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div class="ai-toolbar-spacer" aria-hidden="true"></div>
          <Select
            :model-value="selectedModel"
            :disabled="modelSelectDisabled"
            @update:model-value="handleModelChange"
          >
            <SelectTrigger aria-label="选择模型" class="ai-model-trigger">
              <AiProviderIcon
                class="ai-model-trigger__icon"
                :platform-id="selectedPlatformId"
                decorative
              />
              <span class="ai-model-trigger__label" v-text="selectedModelLabel"></span>
            </SelectTrigger>
            <SelectContent
              side="top"
              align="end"
              :side-offset="8"
              class="ai-model-content"
            >
              <template
                v-for="(section, sectionIndex) in modelSections"
                :key="section.key"
              >
                <SelectLabel class="ai-model-section-label">
                  <span v-text="section.label"></span>
                  <span
                    v-if="section.badge"
                    class="ai-model-beta"
                    v-text="section.badge"
                  ></span>
                </SelectLabel>
                <SelectGroup>
                  <SelectItem
                    v-for="model in section.models"
                    :key="model.id"
                    class="ai-model-item"
                    :value="model.id"
                  >
                    <AiProviderIcon
                      class="ai-model-item__icon"
                      :platform-id="section.key"
                      decorative
                    />
                    <span class="ai-model-item__label" v-text="model.label"></span>
                  </SelectItem>
                </SelectGroup>
                <SelectSeparator
                  v-if="sectionIndex < modelSections.length - 1"
                  class="ai-model-separator"
                />
              </template>
            </SelectContent>
          </Select>
          <Context v-bind="resolvedTokenContext" :cost="tokenUsageCost">
            <ContextTrigger class="ai-token-trigger" aria-label="Token 消耗" />
            <ContextContent
              side="top"
              align="end"
              :side-offset="8"
              class="ai-token-content"
            >
              <ContextContentHeader />
              <ContextContentBody>
                <ContextInputUsage />
                <ContextOutputUsage />
              </ContextContentBody>
              <ContextContentFooter class="bg-[#f4f4f5]" />
            </ContextContent>
          </Context>
          <InputGroupButton
            v-if="disabled && stopVisible"
            type="button"
            variant="outline"
            class="ai-send-button"
            size="icon-xs"
            aria-label="停止"
            @click="handleStop"
          >
            <Square class="size-4" />
            <span class="sr-only">Stop</span>
          </InputGroupButton>
          <InputGroupButton
            v-else
            type="submit"
            variant="default"
            class="ai-send-button"
            size="icon-xs"
            :disabled="disabled || !canSubmit"
            :aria-label="submitLabel"
          >
            <ArrowUp class="size-4" />
            <span class="sr-only">Send</span>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
    <AiSlashCommandMenu
      :open="slashOpen"
      :query="slashQuery"
      :skills="skills"
      :anchor-rect="slashAnchorRect"
      @select-skill="handleSelectSkill"
      @close="closeSlashMenu"
    />
    <SkillManagerDialog v-model:open="skillsManagerOpen" @saved="loadSkills" />
  </footer>
</template>

<style scoped>
.ai-composer {
  --ai-composer-control-size: 30px;
  --ai-composer-icon-size: 17px;
  flex: 0 0 auto;
  display: grid;
  align-self: stretch;
  gap: 6px;
  min-width: 0;
  width: min(100%, 710px);
  max-width: 860px;
  box-sizing: border-box;
  margin-inline: auto;
  padding: 0 12px 28px;
}

.ai-composer-surface {
  width: 100%;
  min-width: 0;
  display: grid;
  gap: 8px;
}

.ai-prompt-shell {
  position: relative;
  width: 100%;
  background: var(--panel-bg);
  border: none !important;
  border-radius: 18px;
  box-shadow: none !important;
  overflow: hidden;
}

.ai-prompt-shell::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: inherit;
  pointer-events: none;
  box-shadow:
    inset 0 0 0 1px #fefefe,
    inset 0 0 0 2px #f5f5f4,
    inset 0 0 0 3px #eeedeb;
}

.ai-prompt-shell :deep([data-slot='input-group-control']:focus-visible),
.ai-prompt-shell :deep(button:focus-visible) {
  outline: none;
  box-shadow: none;
}

.ai-attachments {
  min-width: 0;
  padding: 0 2px;
}

.ai-prompt-editor-wrap {
  position: relative;
  width: 100%;
  min-width: 0;
}

.ai-prompt-textarea {
  --ai-prompt-line-box: 20.4px;
  --ai-prompt-scrollbar-thumb: color-mix(in srgb, var(--text-primary) 12%, transparent);
  min-height: 56px;
  max-height: 192px;
  border: 0;
  background: var(--panel-bg);
  padding: 14px 20px 7px;
  color: var(--text-primary);
  font-size: 16px;
  line-height: var(--ai-prompt-line-box);
  box-shadow: none;
  outline: none;
  resize: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--ai-prompt-scrollbar-thumb) transparent;
  text-align: left;
}

.ai-prompt-editor {
  white-space: pre-wrap;
  word-break: break-word;
  cursor: text;
}

.ai-prompt-editor:focus,
.ai-prompt-editor:focus-visible {
  outline: none;
}

.ai-prompt-placeholder {
  position: absolute;
  top: 14px;
  left: 20px;
  color: var(--text-tertiary);
  font-size: 16px;
  line-height: var(--ai-prompt-line-box);
  pointer-events: none;
  user-select: none;
}

.ai-skill-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 3px 0 1px;
  padding: 1px 9px 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, #2783de 12%, transparent);
  color: #2061a8;
  font-size: 13px;
  line-height: 1.5;
  vertical-align: baseline;
  white-space: nowrap;
  user-select: none;
}

.ai-skill-pill__icon {
  width: 13px;
  height: 13px;
  flex: none;
  color: #2783de;
}

.ai-skill-pill__label {
  white-space: nowrap;
}

.ai-prompt-textarea::-webkit-scrollbar {
  width: 6px;
}

.ai-prompt-textarea::-webkit-scrollbar-track {
  background: transparent;
}

.ai-prompt-textarea::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 999px;
  background: var(--ai-prompt-scrollbar-thumb);
  background-clip: content-box;
}

.ai-prompt-textarea::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--text-primary) 18%, transparent);
  background-clip: content-box;
}

.ai-prompt-textarea::placeholder {
  color: var(--text-tertiary);
  opacity: 1;
}

.ai-toolbar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  margin-top: 10px;
  padding: 0 10px 10px 14px;
  background: var(--panel-bg);
}

.ai-toolbar-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transform: translate(-3px, 3px);
}

.ai-toolbar-spacer {
  flex: 1 1 auto;
  min-width: 12px;
}

.ai-icon-action {
  width: var(--ai-composer-control-size);
  height: var(--ai-composer-control-size);
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  box-shadow: none;
  transition: background-color 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-icon-action:active {
  transform: none;
  scale: 1;
}

.ai-icon-action:hover:not(:disabled),
.ai-mode-trigger[data-state='open'] {
  background: color-mix(in srgb, var(--text-primary) 7%, transparent);
  color: var(--text-primary);
}

.ai-icon-action :deep(svg),
.ai-send-button :deep(svg),
.ai-token-trigger :deep(img) {
  width: var(--ai-composer-icon-size);
  height: var(--ai-composer-icon-size);
}

.ai-token-trigger {
  width: var(--ai-composer-control-size);
  height: var(--ai-composer-control-size);
  min-width: var(--ai-composer-control-size);
  gap: 0;
  border-radius: 999px;
  padding: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  box-shadow: none;
  transform: translate(3px, 3px);
}

.ai-token-trigger :deep(svg) {
  width: 22px;
  height: 22px;
  color: var(--text-secondary);
  stroke-width: 1.9;
}

.ai-token-trigger:hover {
  color: var(--text-primary);
}

.ai-token-content {
  color: var(--text-primary);
}

.ai-send-button {
  width: var(--ai-composer-control-size);
  height: var(--ai-composer-control-size);
  border: 0;
  border-radius: 999px;
  background: #2783de;
  color: var(--accent-foreground);
  box-shadow: none;
  transform: translate(3px, 3px);
  transition: background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    opacity 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-send-button:hover:not(:disabled) {
  background: color-mix(in srgb, #2783de 86%, #000);
  color: var(--accent-foreground);
}

.ai-send-button:disabled {
  background: color-mix(in srgb, var(--text-primary) 5%, transparent);
  color: color-mix(in srgb, var(--text-primary) 18%, transparent);
  opacity: 1;
}

.ai-send-button[data-variant='outline'] {
  background: var(--danger);
  color: var(--accent-foreground);
}

.ai-model-trigger {
  display: inline-flex;
  width: auto;
  min-width: 0;
  max-width: 260px;
  height: var(--ai-composer-control-size);
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  padding: 0 8px;
  box-shadow: none;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  transform: translate(3px, 3px);
  transition: background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-model-trigger:hover,
.ai-model-trigger[data-state='open'] {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  color: var(--text-primary);
}

.ai-model-trigger__icon {
  width: var(--ai-composer-icon-size);
  height: var(--ai-composer-icon-size);
}

.ai-model-trigger__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-trigger> :deep(svg:last-child) {
  display: none;
}

.ai-agent-trigger > :deep(svg:last-child) {
  display: none;
}

.ai-agent-trigger {
  display: inline-flex;
  width: auto;
  min-width: 0;
  max-width: 200px;
  height: var(--ai-composer-control-size);
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  padding: 0 8px;
  box-shadow: none;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  transition: background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-agent-trigger:hover,
.ai-agent-trigger[data-state='open'] {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  color: var(--text-primary);
}

.ai-agent-trigger__icon,
.ai-agent-item__icon {
  width: var(--ai-composer-icon-size);
  height: var(--ai-composer-icon-size);
  flex: 0 0 auto;
}

.ai-agent-trigger__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-agent-content {
  width: min(240px, calc(100vw - 24px));
  padding: 8px;
  border: 1px solid var(--ai-menu-border);
  border-radius: 10px;
  box-shadow: var(--ai-menu-shadow);
}

.ai-agent-content [data-slot='select-scroll-up-button'],
.ai-agent-content [data-slot='select-scroll-down-button'] {
  display: none;
}

.ai-agent-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ai-menu-muted);
  font-size: 12px;
  padding: 6px 3px 7px;
}

.ai-agent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  border-radius: 7px;
  color: var(--ai-menu-text);
  font-size: 14px;
  padding: 0 28px 0 7px;
}

.ai-agent-item[data-highlighted],
.ai-agent-item[data-state='checked'] {
  background: var(--ai-menu-hover);
}

.ai-agent-item__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 960px) {
  .ai-composer {
    width: min(100%, 720px);
  }

  .ai-toolbar-row {
    gap: 8px;
    padding-left: 18px;
  }

  .ai-prompt-textarea {
    font-size: 17px;
    padding-inline: 20px;
  }

  .ai-prompt-placeholder {
    font-size: 17px;
  }

  .ai-model-trigger {
    max-width: 220px;
    font-size: 14px;
  }
}
</style>

<style>
.ai-settings-menu,
.ai-settings-submenu,
.ai-model-content,
.ai-agent-content,
.ai-token-content {
  --ai-menu-bg: var(--workbench-content-bg);
  --ai-menu-text: #1f2328;
  --ai-menu-muted: #818b98;
  --ai-menu-border: #d1d9e0b3;
  --ai-menu-hover: #818b981f;
  --ai-menu-shadow: 0 12px 30px rgb(31 35 40 / 12%);
  color-scheme: light;
  border: 1px solid var(--ai-menu-border);
  border-radius: 12px;
  background: var(--ai-menu-bg);
  color: var(--ai-menu-text);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-primary) 2%, transparent),
    var(--ai-menu-shadow);
}

.ai-settings-menu {
  position: relative;
  width: min(248px, calc(100vw - 24px));
  padding: 5px;
  overflow: visible;
  border: none;
  border-radius: 8px;
  box-shadow: 0 0 0 1px #e7e6e4, 0 0 0 2px #efefee, 0 0 0 3px #f7f7f7, 0 0 0 4px #f8f8f8, 0 0 0 5px #f9f9f9, 0 0 0 6px #fafafa, 0 0 0 7px #fbfbfb, 0 0 0 8px #fcfcfc, 0 0 0 9px #fdfdfd, 0 0 0 10px #fefefe;
}
.ai-settings-menu-item {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto auto;
  gap: 9px;
  min-height: 34px;
  align-items: center;
  border-radius: 7px;
  color: var(--ai-menu-text);
  font-size: 14px;
  line-height: 1.2;
  padding: 0 8px;
}

.ai-settings-menu-item[data-highlighted],
.ai-settings-menu-item[data-state='open'] {
  background: var(--ai-menu-hover);
  color: var(--ai-menu-text);
}

.ai-settings-menu-icon,
.ai-settings-menu-chevron {
  width: 16px;
  height: 16px;
  color: var(--ai-menu-text);
  stroke-width: 1.8;
}

.ai-settings-menu-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-settings-menu-value {
  color: var(--ai-menu-muted);
  font-size: 13px;
  line-height: 1.2;
  white-space: nowrap;
}

.ai-settings-submenu {
  width: min(180px, calc(100vw - 24px));
  padding: 5px;
  border-radius: 8px;
}

.ai-settings-mode-item {
  grid-template-columns: minmax(0, 1fr) auto;
  padding-left: 8px;
}

.ai-settings-mode-item[data-active] .ai-settings-menu-label {
  font-weight: 600;
}

.ai-settings-menu-check {
  width: 16px;
  height: 16px;
  color: #2783de;
  stroke-width: 2;
}

.ai-settings-menu-separator {
  height: 1px;
  margin: 5px 4px;
  background: var(--ai-menu-border);
}

.ai-network-switch {
  position: relative;
  width: 30px;
  height: 18px;
  border: 0;
  border-radius: 999px;
  background: var(--ai-menu-border);
  padding: 0;
  transition: background-color 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-network-switch.is-on {
  background: #2783de;
}

.ai-network-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 999px;
  background: #ffffff;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 16%, transparent);
  transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-network-switch.is-on .ai-network-switch__thumb {
  transform: translateX(12px);
}

.ai-model-content {
  width: min(330px, calc(100vw - 24px));
  max-height: min(460px, calc(100vh - 112px));
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--ai-menu-border);
  border-radius: 10px;
  box-shadow: var(--ai-menu-shadow);
}

.ai-model-content [data-slot='select-scroll-up-button'],
.ai-model-content [data-slot='select-scroll-down-button'] {
  display: none;
}
.ai-model-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ai-menu-muted);
  font-size: 12px;
  padding: 6px 3px 7px;
}

.ai-model-beta {
  border-radius: 4px;
  background: var(--ai-menu-hover);
  color: var(--ai-menu-muted);
  padding: 1px 5px;
  font-size: 11px;
  line-height: 1.2;
}

.ai-model-item {
  min-height: 34px;
  border-radius: 7px;
  color: var(--ai-menu-text);
  font-size: 14px;
  padding: 0 28px 0 7px;
}

.ai-model-item[data-highlighted],
.ai-model-item[data-state='checked'] {
  background: var(--ai-menu-hover);
}

.ai-model-item__icon {
  width: 18px;
  height: 18px;
}

.ai-model-item__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-model-separator {
  margin: 8px 0;
  background: var(--ai-menu-border);
}

.ai-token-content {
  position: relative;
  overflow: hidden;
  border: none;
  box-shadow: none;
}

.ai-token-content::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: inherit;
  pointer-events: none;
  box-shadow:
    inset 0 0 0 1px #fefefe,
    inset 0 0 0 2px #f5f5f4,
    inset 0 0 0 3px #eeedeb;
}

.ai-token-content > :not([hidden]) ~ :not([hidden]) {
  border-top: 1px solid #f0f0ef;
}

.ai-token-content [data-slot='context-content-footer'] {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}
</style>