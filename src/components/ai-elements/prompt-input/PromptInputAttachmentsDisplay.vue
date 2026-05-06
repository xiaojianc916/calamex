<script setup lang="ts">
import { FileText, Image as ImageIcon, X } from 'lucide-vue-next';

interface IPromptInputAttachment {
    id: string;
    name: string;
    sizeLabel: string;
    kind: 'text' | 'image';
    detailLabel?: string;
}

defineProps<{
    attachments: readonly IPromptInputAttachment[];
}>();

const emit = defineEmits<{
    remove: [id: string];
}>();

const handleRemove = (id: string): void => {
    emit('remove', id);
};
</script>

<template>
    <div class="prompt-input-attachments-display" aria-label="已添加附件">
        <span v-for="attachment in attachments" :key="attachment.id" class="prompt-input-attachment-chip">
            <ImageIcon v-if="attachment.kind === 'image'" aria-hidden="true" />
            <FileText v-else aria-hidden="true" />
            <span class="prompt-input-attachment-name">{{ attachment.name }}</span>
            <span v-if="attachment.kind !== 'image' && attachment.detailLabel" class="prompt-input-attachment-detail">
                {{ attachment.detailLabel }}
            </span>
            <button type="button" aria-label="移除附件" title="移除附件" @click="handleRemove(attachment.id)">
                <X aria-hidden="true" />
            </button>
        </span>
    </div>
</template>

<style scoped>
.prompt-input-attachments-display {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: 6px;
}

.prompt-input-attachment-chip {
    display: inline-flex;
    min-width: 0;
    max-width: 100%;
    align-items: center;
    gap: 6px;
    border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-soft) 74%, var(--panel-bg));
    padding: 5px 8px 5px 10px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1;
}

.prompt-input-attachment-chip>svg {
    width: 13px;
    height: 13px;
    flex: 0 0 auto;
    color: var(--text-tertiary);
}

.prompt-input-attachment-name {
    min-width: 0;
    overflow: hidden;
    color: var(--text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
}

.prompt-input-attachment-detail {
    color: var(--text-tertiary);
}

.prompt-input-attachment-chip button {
    display: inline-flex;
    height: 18px;
    width: 18px;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 999px;
    background: transparent;
    padding: 0;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease;
}

.prompt-input-attachment-chip button:hover {
    background: color-mix(in srgb, var(--surface-soft) 88%, transparent);
    color: var(--text-primary);
}

.prompt-input-attachment-chip button svg {
    width: 12px;
    height: 12px;
}
</style>