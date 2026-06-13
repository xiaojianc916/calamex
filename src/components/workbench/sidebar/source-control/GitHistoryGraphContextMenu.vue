<script setup lang="ts">
import { computed } from 'vue';
import LinearContextMenu from '@/components/common/LinearContextMenu.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import type { IGitCommitSummaryPayload } from '@/types/git';

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  commit: IGitCommitSummaryPayload | null;
  repositoryUrl: string | null;
}>();

const emit = defineEmits<{
  select: [item: ILinearContextMenuItem];
}>();

const menuGroups = computed<ILinearContextMenuGroup[]>(() => {
  if (!props.commit) return [];
  const groups: ILinearContextMenuGroup[] = [
    {
      key: 'copy',
      items: [
        { key: 'copy-sha', label: '复制提交哈希', icon: 'copy' },
        { key: 'copy-short', label: '复制短哈希', icon: 'copy' },
        { key: 'copy-message', label: '复制提交说明', icon: 'copy' },
      ],
    },
    {
      key: 'actions',
      items: [
        { key: 'checkout-commit', label: '检出此提交', icon: 'git-branch' },
        { key: 'revert-commit', label: '回滚此提交', icon: 'rotate-ccw' },
      ],
    },
  ];
  if (props.repositoryUrl) {
    groups[1].items.push({ key: 'open-github', label: '在 GitHub 上打开', icon: 'external-link' });
  }
  return groups;
});
</script>

<template>
  <LinearContextMenu
    :open="open"
    :x="x"
    :y="y"
    :groups="menuGroups"
    theme="light"
    submenu-direction="right"
    @select="emit('select', $event)"
  />
</template>
