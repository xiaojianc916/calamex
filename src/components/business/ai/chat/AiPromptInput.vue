<script setup lang="ts">
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Globe,
  MessageCircle,
  Network,
  Paintbrush,
  Paperclip,
  Plus,
  Route,
  Settings2,
  SlidersHorizontal,
  Square,
  Workflow,
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';
import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextTrigger,
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

interface IPoint {
  x: number;
  y: number;
}

/** 输入框纯文本（不含技能胶囊） */
const modelValue = defineModel<string>({ required: true });

/** 当前模式（双向绑定） */
const activeMode = defineModel<TAiAssistantMode>('activeMode', { required: true });

/** 已选中的技能胶囊（内联显示在输入框中，独立于纯文本） */
const selectedSkills = defineModel<ISelectedSkill[]>('selectedSkills', {
  default: () => [],
});

const props = defineProps<{
  disabled: boolean;
  stopVisible?: boolean;
  errorMessage: string;
  submitLabel: string;
  attachments: readonly IAiAttachedFile[];
  hasAttachments: boolean;
  tokenContext?: IAiTokenContextProps;
  config: IAiConfigPayload;
  isModelSaving?: boolean;
  networkPermission: TAiAgentNetworkPermission;
  isNetworkPermissionSaving?: boolean;
  executionMode: TAiExecutionMode;
  resolveAttachment: (file: File) => Promise<boolean>;
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
const fileInputRef = ref<HTMLInputElement | null>(null);
const surfaceRef = ref<HTMLFormElement | null>(null);
const editorRef = ref<HTMLDivElement | null>(null);
const isComposing = ref(false);
const isModeSubmenuOpen = ref(false);
const modeMenuItemElement = ref<HTMLElement | null>(null);
const modeSubmenuRef = ref<HTMLElement | null>(null);
const pendingAttachmentDrafts = ref<IAiAttachedFile[]>([]);

// 编辑器内容程序化写入时为 true，避免输入事件回环。
let isApplyingExternalValue = false;
let modeSubmenuCloseTimer: ReturnType<typeof setTimeout> | null = null;

// 技能 / 斜杠菜单状态。
const skills = ref<ISkillSummary[]>([]);
const slashOpen = ref(false);
const slashQuery = ref('');
const slashAnchorRect = ref<ISlashAnchorRect | null>(null);
const skillsManagerOpen = ref(false);
let skillsLoadPromise: Promise<void> | null = null;

const MODE_SUBMENU_CLOSE_DELAY_MS = 180;

const modeOptions: IAiPromptModeOption[] = [
  { key: 'chat', label: 'chat' },
  { key: 'agent', label: 'agent' },
  { key: 'plan', label: 'plan' },
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

const selectedModel = computed(() => props.config.selectedModel?.trim() ?? '');

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
  () => (modelValue.value?.length ?? 0) === 0 && (selectedSkills.value?.length ?? 0) === 0,
);

const modelSelectDisabled = computed(() => props.disabled || props.isModelSaving);

const networkPermissionEnabled = computed(() => props.networkPermission === 'allowed-this-run');

// 执行自主性:autonomous = 开启「自主 plan 模式」(批准后无人值守闭环);
// 默认 interactive = 逐步门控。对标 Cline Auto-approve / Cursor Auto-run。
const executionAutonomous = computed(() => props.executionMode === 'autonomous');

const activeModeOption = computed(
  () => modeOptions.find((option) => option.key === activeMode.value) ?? modeOptions[0],
);

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
// 二级菜单 hover intent：安全走廊算法
// -------------------------------------------------------------------------
const clearModeSubmenuCloseTimer = (): void => {
  if (modeSubmenuCloseTimer === null) {
    return;
  }

  clearTimeout(modeSubmenuCloseTimer);
  modeSubmenuCloseTimer = null;
};

const closeModeSubmenu = (): void => {
  clearModeSubmenuCloseTimer();
  isModeSubmenuOpen.value = false;
};

const openModeSubmenu = (): void => {
  clearModeSubmenuCloseTimer();
  isModeSubmenuOpen.value = true;
};

const scheduleModeSubmenuClose = (): void => {
  clearModeSubmenuCloseTimer();
  modeSubmenuCloseTimer = setTimeout(() => {
    isModeSubmenuOpen.value = false;
    modeSubmenuCloseTimer = null;
  }, MODE_SUBMENU_CLOSE_DELAY_MS);
};

const isPointInsideRect = (point: IPoint, rect: DOMRect, padding = 0): boolean =>
  point.x >= rect.left - padding &&
  point.x <= rect.right + padding &&
  point.y >= rect.top - padding &&
  point.y <= rect.bottom + padding;

const isPointInsideConvexPolygon = (point: IPoint, polygon: readonly IPoint[]): boolean => {
  if (polygon.length < 3) {
    return false;
  }

  let sign = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];

    if (!current || !next) {
      return false;
    }

    const cross =
      (next.x - current.x) * (point.y - current.y) - (next.y - current.y) * (point.x - current.x);

    if (Math.abs(cross) < 0.01) {
      continue;
    }

    const currentSign = cross > 0 ? 1 : -1;

    if (sign === 0) {
      sign = currentSign;
    } else if (sign !== currentSign) {
      return false;
    }
  }

  return true;
};

const isPointerInModeSubmenuIntentArea = (event: PointerEvent): boolean => {
  const trigger = modeMenuItemElement.value;
  const submenu = modeSubmenuRef.value;

  if (!trigger || !submenu) {
    return false;
  }

  const point = { x: event.clientX, y: event.clientY };
  const triggerRect = trigger.getBoundingClientRect();
  const submenuRect = submenu.getBoundingClientRect();

  if (isPointInsideRect(point, triggerRect, 8) || isPointInsideRect(point, submenuRect, 8)) {
    return true;
  }

  const bridge: IPoint[] = [
    { x: triggerRect.right - 2, y: triggerRect.top - 10 },
    { x: submenuRect.left + 2, y: submenuRect.top - 14 },
    { x: submenuRect.left + 2, y: submenuRect.bottom + 14 },
    { x: triggerRect.right - 2, y: triggerRect.bottom + 10 },
  ];

  return isPointInsideConvexPolygon(point, bridge);
};

const handleModeSubmenuDocumentPointerMove = (event: PointerEvent): void => {
  if (!isModeSubmenuOpen.value) {
    return;
  }

  if (isPointerInModeSubmenuIntentArea(event)) {
    clearModeSubmenuCloseTimer();
    return;
  }

  scheduleModeSubmenuClose();
};

const handleModeMenuItemPointerEnter = (event: PointerEvent): void => {
  modeMenuItemElement.value =
    event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  openModeSubmenu();
};

const selectModeOption = (value: TAiAssistantMode): void => {
  handleModeChange(value);
  closeModeSubmenu();
};

watch(isModeSubmenuOpen, (open) => {
  if (typeof document === 'undefined') {
    return;
  }

  if (open) {
    document.addEventListener('pointermove', handleModeSubmenuDocumentPointerMove, {
      passive: true,
    });
  } else {
    document.removeEventListener('pointermove', handleModeSubmenuDocumentPointerMove);
    clearModeSubmenuCloseTimer();
  }
});

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
  modelValue.value = text;
  selectedSkills.value = skills;
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

const handleOpenFileDialog = (): void => {
  if (props.disabled) {
    return;
  }
  fileInputRef.value?.click();
};

const handleFileChange = (event: Event): void => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const fileList = input.files;
  if (!fileList?.length) {
    input.value = '';
    return;
  }
  for (const file of Array.from(fileList)) {
    void queueAttachmentFile(file);
  }
  input.value = '';
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

onBeforeUnmount(() => {
  clearModeSubmenuCloseTimer();

  if (typeof document !== 'undefined') {
    document.removeEventListener('pointermove', handleModeSubmenuDocumentPointerMove);
  }
});
</script>

<template>
  <footer class="ai-composer">
    <form ref="surfaceRef" class="ai-composer-surface" v-bind="attrs" @submit.prevent="handleSubmit">
      <input
        ref="fileInputRef"
        type="file"
        class="hidden"
        multiple
        @change="handleFileChange"
      />
      <div v-if="displayedAttachments.length" class="ai-attachments">
        <PromptInputAttachmentsDisplay
          :attachments="displayedAttachments"
          @remove="handleRemoveAttachment"
        />
      </div>
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
                <DropdownMenuItem
                  class="ai-settings-menu-item"
                  :disabled="disabled || isNetworkPermissionSaving"
                  @select.prevent="toggleNetworkPermission"
                >
                  <Globe class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">网络访问权限</span>
                  <button
                    type="button"
                    class="ai-network-switch"
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
                  @select.prevent="handleOpenInformationSources"
                >
                  <Network class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">我的信息源</span>
                  <ChevronRight class="ai-settings-menu-chevron" />
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="ai-settings-menu-item"
                  @select.prevent="openSkillsManager"
                >
                  <Plus class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">添加skill</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="ai-settings-menu-item is-mode"
                  @pointerenter="handleModeMenuItemPointerEnter"
                  @pointerleave="scheduleModeSubmenuClose"
                  @select.prevent
                  @click.stop="openModeSubmenu"
                >
                  <Route class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">模式</span>
                  <span class="ai-settings-menu-value" v-text="activeModeOption.label"></span>
                  <ChevronRight class="ai-settings-menu-chevron" />
                  <div
                    v-if="isModeSubmenuOpen"
                    ref="modeSubmenuRef"
                    class="ai-mode-submenu"
                    @pointerenter="openModeSubmenu"
                    @pointerleave="scheduleModeSubmenuClose"
                  >
                    <button
                      v-for="option in modeOptions"
                      :key="option.key"
                      type="button"
                      class="ai-mode-submenu-item"
                      :class="{ 'is-active': activeMode === option.key }"
                      @click="selectModeOption(option.key)"
                    >
                      <MessageCircle class="ai-mode-submenu-icon" v-if="option.key === 'chat'" />
                      <Workflow class="ai-mode-submenu-icon" v-else-if="option.key === 'plan'" />
                      <SlidersHorizontal class="ai-mode-submenu-icon" v-else />
                      <span class="ai-mode-submenu-copy">
                        <span class="ai-mode-submenu-label" v-text="option.label"></span>
                      </span>
                      <Check class="ai-mode-submenu-check" v-if="activeMode === option.key" />
                    </button>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="activeMode === 'plan'"
                  class="ai-settings-menu-item"
                  :disabled="disabled"
                  @select.prevent="toggleExecutionMode"
                >
                  <Bot class="ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">自主plan模式</span>
                  <button
                    type="button"
                    class="ai-network-switch"
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
                  @select.prevent="handleOpenPersonalization"
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
                  v-if="sectionIndex < section.models.length - 1"
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
</style>
