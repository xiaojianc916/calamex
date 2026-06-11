<template>
  <div v-if="!isDesktopRuntime" class="explorer-empty-state">
    浏览器预览模式下不显示本地目录树，请在 Tauri 桌面端查看资源文件。
  </div>
  <div v-else-if="loadError" class="explorer-empty-state">
    <InlineError title="无法读取工作区目录" :message="loadError" />
  </div>
  <div v-else-if="rootLoading && !hasRoot" class="explorer-empty-state">正在读取资源目录...</div>
  <Empty v-else-if="!workspaceRootPath" class="explorer-empty-state explorer-empty-state--raised">
    <EmptyHeader class="gap-1.5">
      <EmptyMedia class="h-auto w-auto rounded-none border-0 bg-transparent p-0 shadow-none">
        <FolderOpen class="h-14 w-14" />
      </EmptyMedia>
      <EmptyTitle class="text-[12px] font-medium">尚未打开工作区</EmptyTitle>
      <EmptyDescription class="text-[11px] leading-5">
        点击
        <button type="button" class="explorer-empty-action" @click="emit('open-folder')">
          adding files
        </button>
        <span> 打开一个文件夹。</span>
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
  <div v-else-if="!hasRoot" class="explorer-empty-state">正在准备资源树...</div>
  <Empty v-else-if="isWorkspaceEmpty" class="explorer-empty-state explorer-empty-state--raised">
    <EmptyHeader class="gap-1.5">
      <EmptyMedia class="h-auto w-auto rounded-none border-0 bg-transparent p-0 shadow-none">
        <FolderOpen class="h-14 w-14" />
      </EmptyMedia>
      <EmptyTitle class="text-[12px] font-medium">This folder is empty</EmptyTitle>
      <EmptyDescription class="text-[11px] leading-5">
        Start by
        <button type="button" class="explorer-empty-action" @click="emit('open-folder')">
          adding files
        </button>
        <span> or creating new folders.</span>
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
</template>

<script setup lang="ts">
import { FolderOpen } from '@lucide/vue';
import InlineError from '@/components/common/InlineError.vue';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

defineProps<{
  isDesktopRuntime: boolean;
  loadError: string;
  rootLoading: boolean;
  hasRoot: boolean;
  workspaceRootPath: string | null;
  isWorkspaceEmpty: boolean;
}>();

const emit = defineEmits<{
  'open-folder': [];
}>();
</script>

<style scoped>
.explorer-empty-action {
  color: var(--accent-strong);
  font-weight: 500;
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
.explorer-empty-action:hover {
  color: color-mix(in srgb, var(--accent-strong) 84%, white);
}
.explorer-empty-action:focus-visible {
  outline: none;
  border-radius: 4px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ring) 32%, transparent);
}
.explorer-empty-state--raised {
  transform: translateY(-52px);
}
</style>
