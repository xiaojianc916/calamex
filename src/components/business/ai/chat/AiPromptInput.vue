<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue';
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
import AiProviderIcon from '@/components/business/ai/provider/AiProviderIcon.vue';
import {
  computeDeepSeekCostBreakdown,
  formatCnyCost,
} from '@/components/business/ai/provider/deepseek-pricing';
import FieldError from '@/components/common/FieldError.vue';
import DropdownMenu from '@/components/ui/dropdown-menu/DropdownMenu.vue';
import DropdownMenuContent from '@/components/ui/dropdown-menu/DropdownMenuContent.vue';
import DropdownMenuItem from '@/components/ui/dropdown-menu/DropdownMenuItem.vue';
import DropdownMenuTrigger from '@/components/ui/dropdown-menu/DropdownMenuTrigger.vue';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { IAiTokenContextProps } from '@/composables/ai/useAiTokenContext';
import type { TAiServicePlatformId } from '@/constants/ai/providers';
import {
  AI_SERVICE_PLATFORM_PRESETS,
  findAiServicePlatformByModel,
} from '@/constants/ai/providers';
import type { IAiAttachedFile, IAiConfigPayload, TAiAgentNetworkPermission } from '@/types/ai';

type TAiPromptInputMode = 'chat' | 'agent' | 'plan';

interface IAiPromptModeOption {
  key: TAiPromptInputMode;
  label: string;
  description: string;
}

interface IAiPromptModelOption {
  id: string;
  label: string;
}

interface IAiPromptModelSection {
  key: TAiServicePlatformId;
  label: string;
  badge: string;
  models: IAiPromptModelOption[];
}

/** 输入框文本 */
const modelValue = defineModel<string>({ required: true });

/** 当前模式（双向绑定） */
const activeMode = defineModel<TAiPromptInputMode>('activeMode', { required: true });

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
}>();

const emit = defineEmits<{
  submit: [];
  stop: [];
  fileSelected: [file: File];
  removeFile: [id: string];
  modelChange: [modelId: string];
  networkPermissionChange: [permission: TAiAgentNetworkPermission];
  informationSourcesOpen: [];
  personalizationOpen: [];
  prewarm: [];
}>();

const attrs = useAttrs();
const fileInputRef = ref<HTMLInputElement | null>(null);
const isComposing = ref(false);
const isModeSubmenuOpen = ref(false);
const pendingAttachmentDrafts = ref<IAiAttachedFile[]>([]);
const lastResolvedAttachmentCount = ref(props.attachments.length);

const modeOptions: IAiPromptModeOption[] = [
  { key: 'chat', label: 'chat', description: '仅回答，不进行编辑' },
  { key: 'agent', label: 'agent', description: '可以搜索、编辑等' },
  { key: 'plan', label: 'plan', description: '先规划，然后在获得批准后执行' },
];
const emptyTokenContext: IAiTokenContextProps = {
  usedTokens: 0,
  maxTokens: 0,
  usageSource: 'estimated',
  usage: {
    inputTokens: 0,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens: 0,
    outputTokenDetails: {
      textTokens: 0,
      reasoningTokens: 0,
    },
    totalTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  },
};
const resolvedTokenContext = computed(() => props.tokenContext ?? emptyTokenContext);
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
    return formatSelectedModelLabel(modelId, matched.label);
  }

  return formatSelectedModelLabel(modelId, modelId.split('/').filter(Boolean).at(-1) ?? modelId);
});
const selectedPlatformId = computed<TAiServicePlatformId>(() => selectedPlatform.value.id);

const modelSections = computed<IAiPromptModelSection[]>(() =>
  AI_SERVICE_PLATFORM_PRESETS.map((platform) => ({
    key: platform.id,
    label: platform.label,
    badge: '已接入',
    models: platform.models.map((model) => ({
      id: model.id,
      label: formatModelLabel(model.label),
    })),
  })).filter((section) => section.models.length > 0),
);

const isPromptInputMode = (value: unknown): value is TAiPromptInputMode =>
  value === 'chat' || value === 'agent' || value === 'plan';

const hasProcessingAttachments = computed(() =>
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
const modelSelectDisabled = computed(() => props.disabled || props.isModelSaving);
const networkPermissionEnabled = computed(() => props.networkPermission === 'allowed-this-run');
const activeModeOption = computed(
  () => modeOptions.find((option) => option.key === activeMode.value) ?? modeOptions[0],
);
const networkPermissionLabel = computed(() => (networkPermissionEnabled.value ? '已允许' : '询问'));

watch(
  () => props.attachments.length,
  (nextLength, previousLength) => {
    const resolvedCount = Math.max(0, nextLength - previousLength);
    lastResolvedAttachmentCount.value = nextLength;

    if (resolvedCount === 0) {
      return;
    }

    let remainingResolvedCount = resolvedCount;
    pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.filter((attachment) => {
      if (remainingResolvedCount <= 0 || attachment.status !== 'processing') {
        return true;
      }

      remainingResolvedCount -= 1;
      return false;
    });
  },
);

watch(
  () => props.errorMessage,
  (message) => {
    const normalizedMessage = message.trim();

    if (!normalizedMessage) {
      return;
    }

    pendingAttachmentDrafts.value = pendingAttachmentDrafts.value.map((attachment) =>
      attachment.status === 'processing'
        ? {
            ...attachment,
            status: 'failed',
            errorMessage: normalizedMessage,
          }
        : attachment,
    );
  },
);

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

const formatSelectedModelLabel = (modelId: string, label: string): string => {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (normalizedModelId === 'deepseek/deepseek-v4-pro') {
    return 'v4-pro';
  }
  if (normalizedModelId === 'deepseek/deepseek-v4-flash') {
    return 'v4-flash';
  }
  return formatModelLabel(label);
};

const getModelPlatformId = (modelId: string): TAiServicePlatformId =>
  findAiServicePlatformByModel(modelId).id;

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

const queueAttachmentFile = (file: File): void => {
  pendingAttachmentDrafts.value = [...pendingAttachmentDrafts.value, createPendingAttachment(file)];
  emit('fileSelected', file);
};

const handleSubmit = (): void => {
  if (props.disabled || !canSubmit.value) {
    return;
  }
  emit('submit');
};

const handleModeChange = (value: unknown): void => {
  if (!isPromptInputMode(value)) {
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
    queueAttachmentFile(file);
  }
  input.value = '';
};

const handlePaste = (event: ClipboardEvent): void => {
  const items = event.clipboardData?.items;
  if (!items) {
    return;
  }
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
  if (!pastedFiles.length) {
    return;
  }
  event.preventDefault();
  for (const file of pastedFiles) {
    queueAttachmentFile(file);
  }
};

const handleKeyDown = (event: KeyboardEvent): void => {
  if (event.key !== 'Enter' || event.shiftKey || isComposing.value || event.isComposing) {
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
</script>

<template>
  <footer class="ai-composer">
    <FieldError v-if="errorMessage" class="ai-error" :message="errorMessage" />
    <form class="ai-composer-surface" v-bind="attrs" @submit.prevent="handleSubmit">
      <input ref="fileInputRef" type="file" class="hidden" multiple @change="handleFileChange" />
      <div v-if="displayedAttachments.length" class="ai-attachments">
        <PromptInputAttachmentsDisplay :attachments="displayedAttachments" @remove="handleRemoveAttachment" />
      </div>
      <InputGroup class="ai-prompt-shell">
        <InputGroupTextarea v-model="modelValue" class="ai-prompt-textarea" placeholder="使用 AI 处理各种任务..."
          aria-label="输入消息" :disabled="disabled" @keydown="handleKeyDown" @paste="handlePaste"
          @focus="handlePrewarmIntent" @mouseenter="handlePrewarmIntent" @compositionstart="isComposing = true"
          @compositionend="isComposing = false" />
        <InputGroupAddon align="block-end" class="ai-toolbar-row">
          <div class="ai-toolbar-left">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger as-child>
                  <InputGroupButton type="button" variant="ghost" class="ai-icon-action ai-attachment-button"
                    size="icon-xs" :disabled="disabled" aria-label="提供背景信息" @click="handleOpenFileDialog">
                    <span class="icon-[lucide--paperclip] size-4" />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent side="top" align="start" :side-offset="10" class="ai-composer-tooltip">
                  <p>提供背景信息</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <InputGroupButton type="button" variant="ghost" class="ai-icon-action ai-mode-trigger" size="icon-xs"
                  :disabled="disabled" aria-label="打开 AI 模式设置">
                  <span class="icon-[lucide--settings-2] size-4" />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" :side-offset="8" class="ai-settings-menu">
                <DropdownMenuItem class="ai-settings-menu-item" :disabled="disabled || isNetworkPermissionSaving"
                  @select.prevent="toggleNetworkPermission">
                  <span class="icon-[lucide--globe] ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">网络访问权限</span>
                  <button type="button" class="ai-network-switch" :class="{ 'is-on': networkPermissionEnabled }"
                    :aria-pressed="networkPermissionEnabled" tabindex="-1">
                    <span class="ai-network-switch__thumb" aria-hidden="true"></span>
                    <span class="sr-only" v-text="networkPermissionLabel"></span>
                  </button>
                </DropdownMenuItem>
                <DropdownMenuItem class="ai-settings-menu-item" @select.prevent="handleOpenInformationSources">
                  <span class="icon-[lucide--network] ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">我的信息源</span>
                  <span class="icon-[lucide--chevron-right] ai-settings-menu-chevron" />
                </DropdownMenuItem>
                <DropdownMenuItem class="ai-settings-menu-item" @select.prevent="handleOpenInformationSources">
                  <span class="icon-[lucide--plus] ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">添加信息源</span>
                </DropdownMenuItem>
                <DropdownMenuItem class="ai-settings-menu-item is-mode" @pointerenter="isModeSubmenuOpen = true"
                  @pointerleave="isModeSubmenuOpen = false" @select.prevent>
                  <span class="icon-[lucide--route] ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">模式</span>
                  <span class="ai-settings-menu-value" v-text="activeModeOption.label"></span>
                  <span class="icon-[lucide--chevron-right] ai-settings-menu-chevron" />
                  <div v-if="isModeSubmenuOpen" class="ai-mode-submenu" @pointerenter="isModeSubmenuOpen = true"
                    @pointerleave="isModeSubmenuOpen = false">
                    <button v-for="option in modeOptions" :key="option.key" type="button" class="ai-mode-submenu-item"
                      :class="{ 'is-active': activeMode === option.key }"
                      @click="handleModeChange(option.key); isModeSubmenuOpen = false">
                      <span v-if="option.key === 'chat'" class="icon-[lucide--message-circle] ai-mode-submenu-icon" />
                      <span v-else-if="option.key === 'plan'" class="icon-[lucide--workflow] ai-mode-submenu-icon" />
                      <span v-else class="icon-[lucide--sliders-horizontal] ai-mode-submenu-icon" />
                      <span class="ai-mode-submenu-copy">
                        <span class="ai-mode-submenu-label" v-text="option.label"></span>
                        <span class="ai-mode-submenu-description" v-text="option.description"></span>
                      </span>
                      <span v-if="activeMode === option.key" class="icon-[lucide--check] ai-mode-submenu-check" />
                    </button>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem class="ai-settings-menu-item" @select.prevent="handleOpenPersonalization">
                  <span class="icon-[lucide--paintbrush] ai-settings-menu-icon" />
                  <span class="ai-settings-menu-label">个性化</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div class="ai-toolbar-spacer" aria-hidden="true"></div>
          <Select :model-value="selectedModel" :disabled="modelSelectDisabled" @update:model-value="handleModelChange">
            <SelectTrigger aria-label="选择模型" class="ai-model-trigger">
              <AiProviderIcon class="ai-model-trigger__icon" :platform-id="selectedPlatformId" decorative />
              <span class="ai-model-trigger__label" v-text="selectedModelLabel"></span>
            </SelectTrigger>
            <SelectContent side="top" align="end" :side-offset="8" class="ai-model-content">
              <template v-for="(section, sectionIndex) in modelSections" :key="section.key">
                <SelectLabel class="ai-model-section-label">
                  <span v-text="section.label"></span>
                  <span class="ai-model-beta" v-text="section.badge"></span>
                </SelectLabel>
                <SelectGroup>
                  <SelectItem v-for="model in section.models" :key="model.id" class="ai-model-item" :value="model.id">
                    <AiProviderIcon class="ai-model-item__icon" :platform-id="getModelPlatformId(model.id)"
                      decorative />
                    <span class="ai-model-item__label" v-text="model.label"></span>
                  </SelectItem>
                </SelectGroup>
                <SelectSeparator v-if="sectionIndex < modelSections.length - 1" class="ai-model-separator" />
              </template>
            </SelectContent>
          </Select>

          <Context v-bind="resolvedTokenContext" :cost="tokenUsageCost">
            <ContextTrigger class="ai-token-trigger" aria-label="Token 消耗" />

            <ContextContent side="top" align="end" :side-offset="8" class="ai-token-content">
              <ContextContentHeader />
              <ContextContentBody>
                <ContextInputUsage />
                <ContextOutputUsage />
              </ContextContentBody>
              <ContextContentFooter class="bg-[#f4f4f5]" />
            </ContextContent>
          </Context>

          <InputGroupButton v-if="disabled && stopVisible" type="button" variant="outline" class="ai-send-button"
            size="icon-xs" aria-label="停止" @click="handleStop">
            <span class="icon-[lucide--square] size-4" />
            <span class="sr-only">Stop</span>
          </InputGroupButton>
          <InputGroupButton v-else type="submit" variant="default" class="ai-send-button" size="icon-xs"
            :disabled="disabled || !canSubmit" :aria-label="submitLabel">
            <span class="icon-[lucide--arrow-up] size-4" />
            <span class="sr-only">Send</span>
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
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
  width: 100%;
  background: var(--panel-bg);
  border: 1px solid #efeeec;
  border-radius: 18px;
  box-shadow:
    0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent),
    0 14px 30px color-mix(in srgb, var(--text-primary) 6%, transparent);
  overflow: hidden;
}

.ai-prompt-shell:focus-within {
  border-color: #efeeec;
  box-shadow:
    0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent),
    0 14px 30px color-mix(in srgb, var(--text-primary) 6%, transparent);
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
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
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
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
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
  max-width: 154px;
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
  transition:
    background-color 140ms cubic-bezier(0.23, 1, 0.32, 1),
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

.ai-composer-tooltip {
  border-radius: 6px;
  background: var(--text-primary);
  color: var(--panel-bg);
  padding: 7px 10px;
  font-size: 13px;
  line-height: 1.2;
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

  .ai-model-trigger {
    max-width: 136px;
    font-size: 14px;
  }
}
</style>

<style>
.ai-settings-menu,
.ai-model-content,
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
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text-primary) 2%, transparent),
    var(--ai-menu-shadow);
}

.ai-settings-menu {
  position: relative;
  width: min(300px, calc(100vw - 24px));
  padding: 5px;
  overflow: visible;
}

.ai-settings-menu-item {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto auto;
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
.ai-settings-menu-item[data-state='open'],
.ai-settings-menu-item.is-mode:hover {
  background: var(--ai-menu-hover);
  color: var(--ai-menu-text);
}

.ai-settings-menu-icon,
.ai-settings-menu-chevron {
  width: 18px;
  height: 18px;
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
  text-transform: lowercase;
}

.ai-network-switch {
  position: relative;
  width: 36px;
  height: 20px;
  border: 0;
  border-radius: 999px;
  background: var(--ai-menu-border);
  padding: 0;
}

.ai-network-switch.is-on {
  background: var(--accent-strong);
}

.ai-network-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--ai-menu-bg);
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 16%, transparent);
  transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1);
}

.ai-network-switch.is-on .ai-network-switch__thumb {
  transform: translateX(16px);
}

.ai-mode-submenu {
  position: absolute;
  left: calc(100% + 6px);
  top: auto;
  bottom: 0;
  z-index: 70;
  display: grid;
  width: min(300px, calc(100vw - 24px));
  max-height: min(240px, calc(100vh - 32px));
  overflow-y: auto;
  gap: 2px;
  border: 1px solid var(--ai-menu-border);
  border-radius: 12px;
  background: var(--ai-menu-bg);
  padding: 5px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text-primary) 2%, transparent),
    var(--ai-menu-shadow);
}

.ai-mode-submenu-item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) 18px;
  gap: 9px;
  min-height: 50px;
  align-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--ai-menu-text);
  padding: 6px 8px;
  text-align: left;
}

.ai-mode-submenu-item:hover,
.ai-mode-submenu-item.is-active {
  background: var(--ai-menu-hover);
}

.ai-mode-submenu-icon,
.ai-mode-submenu-check {
  width: 18px;
  height: 18px;
  stroke-width: 1.8;
}

.ai-mode-submenu-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.ai-mode-submenu-label {
  color: var(--ai-menu-text);
  font-size: 14px;
  line-height: 1.2;
}

.ai-mode-submenu-description {
  color: var(--ai-menu-muted);
  font-size: 12px;
  line-height: 1.25;
}

.ai-model-content {
  width: min(360px, calc(100vw - 24px));
  max-height: min(520px, calc(100vh - 112px));
  overflow-y: auto;
  padding: 9px;
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
  overflow: hidden;
}

.ai-token-content [data-slot='context-content-footer'] {
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}
</style>
