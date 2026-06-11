<script setup lang="ts">
import type { ISshFileItem } from '@/types/ssh';

defineProps<{
  isCreateDirectoryDialogOpen: boolean;
  createDirectoryName: string;
  canConfirmCreateDirectory: boolean;
  pendingRenameItem: ISshFileItem | null;
  renameInputValue: string;
  canConfirmRename: boolean;
  pendingDeleteItem: ISshFileItem | null;
  isPathMutating: boolean;
  currentRemotePath: string;
  setRenameInput: (el: unknown) => void;
  setCreateDirectoryInput: (el: unknown) => void;
}>();

const emit = defineEmits<{
  'update:createDirectoryName': [value: string];
  'update:renameInputValue': [value: string];
  'confirm-create': [];
  'confirm-rename': [];
  'confirm-delete': [];
  'close-create': [];
  'close-rename': [];
  'close-delete': [];
}>();
</script>

<template>
  <Teleport to="body">
    <div v-if="isCreateDirectoryDialogOpen" class="ssh-modal-backdrop" @click.self="emit('close-create')">
      <form class="ssh-modal" @submit.prevent="emit('confirm-create')">
        <div class="ssh-modal-copy">
          <h3>新建远端文件夹</h3>
          <p>将在“<span v-text="currentRemotePath" />”下创建文件夹。不会覆盖远端已有项目。</p>
        </div>
        <label class="ssh-modal-field">
          <span>文件夹名称</span>
          <input :ref="setCreateDirectoryInput" :value="createDirectoryName" :disabled="isPathMutating"
            autocomplete="off" @input="emit('update:createDirectoryName', ($event.target as HTMLInputElement).value)" />
        </label>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPathMutating" @click="emit('close-create')">
            取消
          </button>
          <button type="submit" class="ssh-modal-button is-primary"
            :disabled="!canConfirmCreateDirectory || isPathMutating" v-text="isPathMutating ? '创建中…' : '创建'" />
        </div>
      </form>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="pendingRenameItem" class="ssh-modal-backdrop" @click.self="emit('close-rename')">
      <form class="ssh-modal" @submit.prevent="emit('confirm-rename')">
        <div class="ssh-modal-copy">
          <h3>重命名远端项目</h3>
          <p>为“<span v-text="pendingRenameItem?.name" />”输入新的名称。不会覆盖远端已有项目。</p>
        </div>
        <label class="ssh-modal-field">
          <span>新名称</span>
          <input :ref="setRenameInput" :value="renameInputValue" :disabled="isPathMutating" autocomplete="off"
            @input="emit('update:renameInputValue', ($event.target as HTMLInputElement).value)" />
        </label>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPathMutating" @click="emit('close-rename')">
            取消
          </button>
          <button type="submit" class="ssh-modal-button is-primary" :disabled="!canConfirmRename || isPathMutating"
            v-text="isPathMutating ? '重命名中…' : '重命名'" />
        </div>
      </form>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="pendingDeleteItem" class="ssh-modal-backdrop" @click.self="emit('close-delete')">
      <section class="ssh-modal is-danger" role="alertdialog" aria-modal="true">
        <div class="ssh-modal-copy">
          <h3>删除远端项目？</h3>
          <p>将删除“<span v-text="pendingDeleteItem?.name" />”。此操作不可撤销，请确认这是你想要的操作。</p>
        </div>
        <div class="ssh-modal-actions">
          <button type="button" class="ssh-modal-button" :disabled="isPathMutating" @click="emit('close-delete')">
            取消
          </button>
          <button type="button" class="ssh-modal-button is-danger" :disabled="isPathMutating"
            @click="emit('confirm-delete')" v-text="isPathMutating ? '删除中…' : '删除'" />
        </div>
      </section>
    </div>
  </Teleport>
</template>
