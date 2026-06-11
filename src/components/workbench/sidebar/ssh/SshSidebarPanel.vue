<script setup lang="ts">
import { Server } from '@lucide/vue';
import '@/assets/css/ssh-sidebar.css';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import SshFilePreviewDialog from '@/components/workbench/SshFilePreviewDialog.vue';
import { useSshStore } from '@/store/ssh';
import SshConnectForm from './SshConnectForm.vue';
import SshPathContextMenu from './SshPathContextMenu.vue';
import SshPathDialogs from './SshPathDialogs.vue';
import SshRecentConnections from './SshRecentConnections.vue';
import SshRemoteExplorer from './SshRemoteExplorer.vue';
import SshTransferList from './SshTransferList.vue';
import { SSH_AUTH_OPTIONS } from './ssh-sidebar.constants';
import { useSshConnection } from './useSshConnection';
import { useSshConnectionForm } from './useSshConnectionForm';
import { useSshRemoteSession } from './useSshRemoteSession';
import { useSshTerminalBridge } from './useSshTerminalBridge';

const emit = defineEmits<{
  'open-terminal': [];
}>();

const sshStore = useSshStore();
const {
  activeContentTab,
  isConnectFormVisible,
  isConnected,
  selectedFileId,
  normalizedRecentConnections,
  sshFileItems,
  transferItems,
  currentRemotePath,
} = storeToRefs(sshStore);

const form = useSshConnectionForm();
const terminal = useSshTerminalBridge({
  connectionForm: form.connectionForm,
  emitOpenTerminal: () => emit('open-terminal'),
});
const session = useSshRemoteSession({
  createSshDirectoryRequest: form.createSshDirectoryRequest,
  createSshFileTransferRequest: form.createSshFileTransferRequest,
  createSshFileUploadRequest: form.createSshFileUploadRequest,
  createSshPathDeleteRequest: form.createSshPathDeleteRequest,
  createSshPathRenameRequest: form.createSshPathRenameRequest,
  createSshDirectoryCreateRequest: form.createSshDirectoryCreateRequest,
  createSshFileReadRequest: form.createSshFileReadRequest,
  createSshFileWriteRequest: form.createSshFileWriteRequest,
});
const connection = useSshConnection({ form, session, terminal });

const {
  host,
  port,
  username,
  authMode,
  identityPath,
  password,
  connectionFieldErrors,
  isPasswordVisible,
  passwordInputType,
} = form;

const {
  isRemoteDirectoryLoading,
  isPathMutating,
  sshBreadcrumbItems,
  previewFileItem,
  previewPayload,
  isPreviewLoading,
  isPreviewSaving,
  pendingRenameItem,
  pendingDeleteItem,
  isCreateDirectoryDialogOpen,
  renameInputValue,
  createDirectoryName,
  renameInputRef,
  createDirectoryInputRef,
  canConfirmRename,
  canConfirmCreateDirectory,
  contextMenu,
  handlePathSegmentClick,
  refreshCurrentRemoteDirectory,
  handleSelectFile,
  handleOpenFile,
  handleFileContextMenu,
  handleContextMenuSelect,
  closePreviewDialog,
  reloadPreviewFile,
  downloadPreviewFile,
  savePreviewFile,
  closeRenameDialog,
  confirmRenamePath,
  closeDeleteDialog,
  confirmDeletePath,
  closeCreateDirectoryDialog,
  confirmCreateDirectory,
} = session;

const {
  isConnecting,
  connectionStatusText,
  connectionErrorText,
  isTabActive,
  handleAuthModeChange,
  setContentTab,
  openConnectForm,
  toggleConnectForm,
  handleCancelConnect,
  handleConnectSubmit,
  handleSelectRecentConnection,
  disconnectSshSession,
} = connection;

const isExplorerActive = computed(() => activeContentTab.value === 'explorer');
const isTransferActive = computed(() => activeContentTab.value === 'transfer');
const isDisconnected = computed(() => !isConnected.value);

const setRenameInput = (el: unknown): void => {
  renameInputRef.value = el as HTMLInputElement | null;
};
const setCreateDirectoryInput = (el: unknown): void => {
  createDirectoryInputRef.value = el as HTMLInputElement | null;
};
const togglePasswordVisibility = (): void => {
  isPasswordVisible.value = !isPasswordVisible.value;
};
</script>

<template>
  <section class="ssh-sidebar-panel" aria-label="SSH 连接侧边栏">
    <div class="ssh-tabs" :class="{ 'ssh-tabs--disconnected': isDisconnected }" role="tablist"
      aria-label="SSH 侧边栏分组">
      <button type="button" class="ssh-tab" :class="{
        'ssh-tab--disconnected': isDisconnected,
        'is-active': isTabActive('explorer'),
        'is-disabled': isDisconnected,
      }" role="tab" :aria-selected="isTabActive('explorer')" :aria-disabled="isDisconnected" :disabled="isDisconnected"
        title="连接后可用" @click="setContentTab('explorer')">
        文件
      </button>
      <button type="button" class="ssh-tab" :class="{
        'ssh-tab--disconnected': isDisconnected,
        'is-active': isTabActive('transfer'),
        'is-disabled': isDisconnected,
      }" role="tab" :aria-selected="isTabActive('transfer')" :aria-disabled="isDisconnected" :disabled="isDisconnected"
        title="连接后可用" @click="setContentTab('transfer')">
        传输
      </button>
      <button type="button" class="ssh-tab" :class="{
        'ssh-tab--disconnected': isDisconnected,
        'is-active': isTabActive('connect'),
      }" role="tab" :aria-selected="isTabActive('connect')" @click="toggleConnectForm">
        连接
      </button>
    </div>

    <div class="ssh-panel-body"
      :class="isDisconnected ? 'ssh-panel-body--disconnected' : 'ssh-panel-body--connected'">
      <SshConnectForm v-if="isConnectFormVisible" v-model:host="host" v-model:port="port" v-model:username="username"
        v-model:identity-path="identityPath" v-model:password="password" :auth-mode="authMode"
        :errors="connectionFieldErrors" :auth-options="SSH_AUTH_OPTIONS" :is-connecting="isConnecting"
        :is-password-visible="isPasswordVisible" :password-input-type="passwordInputType"
        :status-text="connectionStatusText" :error-text="connectionErrorText" :is-disconnected="isDisconnected"
        @submit="handleConnectSubmit" @cancel="handleCancelConnect" @auth-mode-change="handleAuthModeChange"
        @toggle-password="togglePasswordVisibility" />

      <section v-else-if="isDisconnected" class="ssh-empty-state ssh-empty-state--disconnected"
        aria-label="SSH 未连接状态">
        <Server class="ssh-empty-icon" aria-hidden="true" />
        <div class="ssh-empty-copy">
          <div class="ssh-empty-title ssh-empty-title--disconnected">尚未连接到远程主机</div>
          <div class="ssh-empty-desc ssh-empty-desc--disconnected">
            连接一台 SSH 服务器后，即可在此浏览文件、上传下载以及管理远程资源
          </div>
        </div>
        <div class="ssh-empty-actions ssh-empty-actions--disconnected">
          <button type="button"
            class="ssh-button ssh-button--primary ssh-button--stacked ssh-button--disconnected-primary"
            @click="openConnectForm">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
              stroke-linejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
              <path d="M12 5l7 7-7 7" />
            </svg>
            新建连接
          </button>
        </div>
        <SshRecentConnections :connections="normalizedRecentConnections"
          @select="handleSelectRecentConnection" />
      </section>

      <template v-else>
        <SshRemoteExplorer v-if="isExplorerActive" :breadcrumb-items="sshBreadcrumbItems"
          :current-remote-path="currentRemotePath" :loading="isRemoteDirectoryLoading" :file-items="sshFileItems"
          :selected-file-id="selectedFileId" @navigate="handlePathSegmentClick" @select="handleSelectFile"
          @open="handleOpenFile" @contextmenu="handleFileContextMenu" @refresh="refreshCurrentRemoteDirectory"
          @disconnect="disconnectSshSession" />

        <SshTransferList v-else-if="isTransferActive" :items="transferItems" />
      </template>
    </div>
  </section>

  <SshPathContextMenu :open="isConnected && contextMenu.open" :x="contextMenu.x" :y="contextMenu.y"
    @select="handleContextMenuSelect" />

  <SshFilePreviewDialog v-if="previewFileItem" :file-item="previewFileItem" :payload="previewPayload"
    :is-loading="isPreviewLoading" :is-saving="isPreviewSaving" @close="closePreviewDialog"
    @reload="reloadPreviewFile" @download="downloadPreviewFile" @save="savePreviewFile" />

  <SshPathDialogs :is-create-directory-dialog-open="isCreateDirectoryDialogOpen"
    :create-directory-name="createDirectoryName" :can-confirm-create-directory="canConfirmCreateDirectory"
    :pending-rename-item="pendingRenameItem" :rename-input-value="renameInputValue"
    :can-confirm-rename="canConfirmRename" :pending-delete-item="pendingDeleteItem" :is-path-mutating="isPathMutating"
    :current-remote-path="currentRemotePath" :set-rename-input="setRenameInput"
    :set-create-directory-input="setCreateDirectoryInput"
    @update:create-directory-name="createDirectoryName = $event"
    @update:rename-input-value="renameInputValue = $event" @confirm-create="confirmCreateDirectory"
    @confirm-rename="confirmRenamePath" @confirm-delete="confirmDeletePath"
    @close-create="closeCreateDirectoryDialog" @close-rename="closeRenameDialog" @close-delete="closeDeleteDialog" />
</template>
