<script setup lang="ts">
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';

defineProps<{
  open: boolean;
  x: number;
  y: number;
}>();

const emit = defineEmits<{
  select: [item: ILinearContextMenuItem];
}>();

const SSH_CONTEXT_MENU_GROUPS: ILinearContextMenuGroup[] = [
  {
    key: 'file-actions',
    title: '',
    items: [
      { key: 'new-folder', label: '新建文件夹', icon: 'plus' },
      { key: 'rename', label: '重命名', icon: 'rename' },
      { key: 'copy-path', label: '复制路径', icon: 'copy' },
      { key: 'download', label: '下载到本地', icon: 'download' },
      { key: 'upload', label: '上传到此处', icon: 'upload' },
    ],
  },
  {
    key: 'danger-actions',
    title: '',
    items: [{ key: 'delete', label: '删除', icon: 'trash', variant: 'destructive' }],
  },
];

const handleSelect = (item: ILinearContextMenuItem): void => {
  emit('select', item);
};
</script>

<template>
  <LinearContextMenu :open="open" :x="x" :y="y" :groups="SSH_CONTEXT_MENU_GROUPS" theme="dark"
    submenu-direction="right" @select="handleSelect" />
</template>
