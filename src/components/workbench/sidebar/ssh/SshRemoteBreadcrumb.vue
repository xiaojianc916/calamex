<script setup lang="ts">
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import DropdownMenu from '@/components/ui/dropdown-menu/DropdownMenu.vue';
import DropdownMenuContent from '@/components/ui/dropdown-menu/DropdownMenuContent.vue';
import DropdownMenuItem from '@/components/ui/dropdown-menu/DropdownMenuItem.vue';
import DropdownMenuTrigger from '@/components/ui/dropdown-menu/DropdownMenuTrigger.vue';
import type { ISshPathSegment } from '@/types/ssh';
import type { TSshBreadcrumbItem } from './useSshRemoteDirectory';

defineProps<{
  items: TSshBreadcrumbItem[];
  currentRemotePath: string;
  loading: boolean;
}>();

const emit = defineEmits<{
  navigate: [segment: ISshPathSegment];
}>();

const handleNavigate = (segment: ISshPathSegment): void => {
  emit('navigate', segment);
};
</script>

<template>
  <Breadcrumb class="ssh-path-breadcrumb" aria-label="远端路径">
    <BreadcrumbList class="ssh-path-list">
      <template v-for="(item, index) in items" :key="item.id">
        <BreadcrumbItem v-if="item.type === 'ellipsis'">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button type="button" class="ssh-path-ellipsis" :disabled="loading" aria-label="展开中间路径">
                <BreadcrumbEllipsis class="ssh-path-ellipsis-icon" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="ssh-path-menu">
              <DropdownMenuItem v-for="segment in item.segments" :key="segment.id" class="ssh-path-menu-item"
                :disabled="loading" @select="handleNavigate(segment)" v-text="segment.label" />
            </DropdownMenuContent>
          </DropdownMenu>
        </BreadcrumbItem>
        <BreadcrumbItem v-else>
          <BreadcrumbPage v-if="item.path === currentRemotePath" class="ssh-path-segment is-current"
            v-text="item.label" />
          <BreadcrumbLink v-else as-child>
            <button type="button" class="ssh-path-segment" :disabled="loading" @click="handleNavigate(item)"
              v-text="item.label" />
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator v-if="index < items.length - 1" class="ssh-path-separator" />
      </template>
    </BreadcrumbList>
  </Breadcrumb>
</template>
