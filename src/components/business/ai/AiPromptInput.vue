<script setup lang="ts">
import { PromptInputAttachmentsDisplay } from '@/components/ai-elements/prompt-input';
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
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { ArrowUpIcon, PlusIcon, SquareIcon } from 'lucide-vue-next';
import { computed, ref } from 'vue';

type TAiPromptInputMode = 'chat' | 'agent' | 'plan';

interface IAiPromptModeOption {
    key: TAiPromptInputMode;
    label: string;
}

/** 输入框文本 */
const modelValue = defineModel<string>({ required: true });

/** 当前模式（双向绑定） */
const activeMode = defineModel<TAiPromptInputMode>('activeMode', { required: true });

const props = defineProps<{
    disabled: boolean;
    errorMessage: string;
    submitLabel: string;
    attachments: readonly {
        id: string;
        name: string;
        sizeLabel: string;
        kind: 'text' | 'image';
        detailLabel?: string;
    }[];
    hasAttachments: boolean;
}>();

const emit = defineEmits<{
    submit: [];
    stop: [];
    fileSelected: [file: File];
    removeFile: [id: string];
}>();

const fileInputRef = ref<HTMLInputElement | null>(null);
const isComposing = ref(false);

const modeOptions: IAiPromptModeOption[] = [
    { key: 'chat', label: 'Chat' },
    { key: 'agent', label: 'Agent' },
    { key: 'plan', label: 'Plan' },
];

const isPromptInputMode = (value: unknown): value is TAiPromptInputMode =>
    value === 'chat' || value === 'agent' || value === 'plan';

const canSubmit = computed(() => modelValue.value.trim().length > 0 || props.hasAttachments);

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

const handleRemoveAttachment = (id: string): void => {
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
        emit('fileSelected', file);
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
    pastedFiles.forEach((file) => emit('fileSelected', file));
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
        <p v-if="errorMessage" v-text="errorMessage" class="ai-error" />
        <form class="ai-composer-surface" @submit.prevent="handleSubmit">
            <input ref="fileInputRef" type="file" class="hidden" multiple @change="handleFileChange" />
            <InputGroup class="ai-prompt-shell">
                <div v-if="attachments.length" class="ai-attachments">
                    <PromptInputAttachmentsDisplay :attachments="attachments" @remove="handleRemoveAttachment" />
                </div>
                <InputGroupTextarea v-model="modelValue" class="ai-prompt-textarea" placeholder="Ask, Search or Chat..."
                    aria-label="输入消息" :disabled="disabled" @keydown="handleKeyDown" @paste="handlePaste"
                    @compositionstart="isComposing = true" @compositionend="isComposing = false" />
                <InputGroupAddon align="block-end" class="ai-toolbar-row">
                    <InputGroupButton type="button" variant="outline" class="ai-attachment-button rounded-full"
                        size="icon-xs" :disabled="disabled" aria-label="添加附件" title="添加附件"
                        @click="handleOpenFileDialog">
                        <PlusIcon class="size-4" />
                    </InputGroupButton>

                    <Select :model-value="activeMode" :disabled="disabled" @update:model-value="handleModeChange">
                        <SelectTrigger aria-label="选择模式"
                            class="!h-auto !min-h-0 !w-auto !border-0 !bg-transparent !text-slate-400 hover:!text-slate-500 !shadow-none !px-1 !py-0.5 !text-xs !font-medium !gap-1 !ring-0 focus:!ring-0 focus-visible:!ring-0 [&>svg]:!size-3 [&>svg]:!opacity-60">
                            <SelectValue placeholder="Chat" />
                        </SelectTrigger>
                        <SelectContent side="top" align="start" class="ai-mode-content">
                            <SelectGroup>
                                <SelectItem v-for="option in modeOptions" :key="option.key" :value="option.key"
                                    v-text="option.label" />
                            </SelectGroup>
                        </SelectContent>
                    </Select>

                    <InputGroupButton v-if="disabled" type="button" variant="outline"
                        class="ai-send-button rounded-full ml-auto" size="icon-xs" aria-label="停止" title="停止"
                        @click="handleStop">
                        <SquareIcon class="size-4" />
                        <span class="sr-only">Stop</span>
                    </InputGroupButton>
                    <InputGroupButton v-else type="submit" variant="default" class="ai-send-button rounded-full ml-auto"
                        size="icon-xs" :disabled="!canSubmit" :aria-label="submitLabel" :title="submitLabel">
                        <ArrowUpIcon class="size-4" />
                        <span class="sr-only">Send</span>
                    </InputGroupButton>
                </InputGroupAddon>
            </InputGroup>
        </form>
    </footer>
</template>

<style scoped>
.ai-composer {
    flex: 0 0 auto;
    display: grid;
    align-self: stretch;
    gap: 6px;
    min-width: 0;
    width: min(100%, 620px);
    max-width: 620px;
    box-sizing: border-box;
    margin-inline: auto;
    padding: 0 8px 8px;
}

.ai-error {
    margin: 0 4px;
    color: var(--danger);
    font-size: 12px;
    line-height: 18px;
}

.ai-composer-surface {
    width: 100%;
    min-width: 0;
}

.ai-prompt-shell {
    width: 100%;
    background: #ffffff;
    border: 1px solid rgba(15, 23, 42, 0.08);
    border-radius: 1rem;
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
    overflow: hidden;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.ai-prompt-shell:focus-within {
    border-color: rgba(15, 23, 42, 0.16);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.ai-prompt-shell:has([data-slot='input-group-control']:focus-visible),
.ai-prompt-shell:has(button:focus-visible) {
    border-color: rgba(15, 23, 42, 0.16);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.ai-prompt-shell :deep([data-slot='input-group-control']:focus-visible),
.ai-prompt-shell :deep(button:focus-visible) {
    outline: none;
    box-shadow: none;
}

.ai-attachments {
    padding: 10px 14px 0;
    background: #ffffff;
}

.ai-prompt-textarea {
    min-height: 60px;
    border: 0;
    background: #ffffff;
    padding: 12px 16px 2px;
    color: var(--text-primary);
    font-size: 15px;
    line-height: 1.36;
    box-shadow: none;
    outline: none;
    resize: none;
    text-align: left;
}

.ai-prompt-textarea::placeholder {
    color: #5f7088;
    opacity: 1;
}

.ai-toolbar-row {
    gap: 12px;
    padding: 0 14px 12px;
    background: #ffffff;
}

.ai-attachment-button {
    border-color: rgba(15, 23, 42, 0.1);
    background: #ffffff;
    color: #6b7280;
    box-shadow: none;
}

.ai-attachment-button:hover {
    border-color: rgba(15, 23, 42, 0.16);
    background: #ffffff;
    color: #374151;
}

.ai-send-button {
    border: 0;
    background: #79cfbe;
    color: #ffffff;
    box-shadow: none;
}

.ai-send-button:hover:not(:disabled) {
    background: #68c2b1;
    color: #ffffff;
}

.ai-send-button:disabled {
    opacity: 0.55;
}

.ai-send-button[data-variant='outline'] {
    background: #f97373;
    color: #ffffff;
}

@media (max-width: 960px) {
    .ai-toolbar-row {
        gap: 10px;
    }
}
</style>

<style>
.ai-mode-content {
    background-color: #ffffff !important;
    color: #0f172a !important;
    border: 1px solid rgba(15, 23, 42, 0.08) !important;
    box-shadow:
        0 8px 24px rgba(15, 23, 42, 0.08),
        0 2px 6px rgba(15, 23, 42, 0.04) !important;
    border-radius: 10px !important;
    padding: 4px !important;
}

.ai-mode-content [role='option'],
.ai-mode-content [data-slot='select-item'] {
    color: #334155 !important;
    font-size: 13px !important;
    padding-block: 6px !important;
    border-radius: 6px !important;
}

.ai-mode-content [role='option'][data-highlighted],
.ai-mode-content [data-slot='select-item'][data-highlighted] {
    background-color: rgba(15, 23, 42, 0.05) !important;
    color: #0f172a !important;
}

.ai-mode-content [role='option'][data-state='checked'],
.ai-mode-content [data-slot='select-item'][data-state='checked'] {
    color: #0f172a !important;
    font-weight: 500;
}
</style>