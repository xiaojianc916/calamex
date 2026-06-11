<script setup lang="ts">
import { RefreshCw, Unplug } from '@lucide/vue';
import type { ISshFileItem, ISshPathSegment } from '@/types/ssh';
import SshRemoteBreadcrumb from './SshRemoteBreadcrumb.vue';
import SshRemoteFileList from './SshRemoteFileList.vue';
import type { TSshBreadcrumbItem } from './useSshRemoteDirectory';

defineProps<{
  breadcrumbItems: TSshBreadcrumbItem[];
  currentRemotePath: string;
  loading: boolean;
  fileItems: ISshFileItem[];
  selectedFileId: string;
}>();

const emit = defineEmits<{
  navigate: [segment: ISshPathSegment];
  select: [fileId: string];
  open: [fileId: string];
  contextmenu: [event: MouseEvent, fileId: string];
  refresh: [];
  disconnect: [];
}>();
</script>

<template>
  <div class="ssh-path-bar">
    <SshRemoteBreadcrumb :items="breadcrumbItems" :current-remote-path="currentRemotePath" :loading="loading"
      @navigate="emit('navigate', $event)" />
    <div class="ssh-path-actions">
      <button type="button" class="ssh-path-action" aria-label="断开 SSH 连接" title="断开连接"
        @click="emit('disconnect')">
        <Unplug aria-hidden="true" />
      </button>
      <button type="button" class="ssh-path-action" :disabled="loading" aria-label="刷新远端目录" title="刷新远端目录"
        @click="emit('refresh')">
        <RefreshCw aria-hidden="true" />
      </button>
    </div>
  </div>

  <SshRemoteFileList :items="fileItems" :selected-file-id="selectedFileId" :loading="loading"
    @select="emit('select', $event)" @open="emit('open', $event)"
    @contextmenu="(event, fileId) => emit('contextmenu', event, fileId)" />
</template>
