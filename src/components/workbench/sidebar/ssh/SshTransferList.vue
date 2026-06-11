<script setup lang="ts">
import type { ISshTransferItem } from '@/types/ssh';

defineProps<{
  items: ISshTransferItem[];
}>();
</script>

<template>
  <div class="ssh-transfer-panel" aria-label="传输任务列表">
    <div v-if="items.length === 0" class="ssh-transfer-empty">
      暂无传输任务
    </div>
    <article v-for="item in items" :key="item.id" class="ssh-transfer-item">
      <div class="ssh-transfer-header">
        <div class="ssh-transfer-name">
          <span class="ssh-transfer-direction" :class="`is-${item.direction}`"
            v-text="item.direction === 'upload' ? '上传' : '下载'" />
          <span v-text="item.name" />
        </div>
        <span class="ssh-transfer-meta" v-text="item.sizeLabel" />
      </div>

      <div class="ssh-progress-bar" aria-hidden="true">
        <div class="ssh-progress-fill" :class="`is-${item.status}`" :style="{ width: `${item.progress}%` }" />
      </div>

      <div class="ssh-transfer-footer">
        <span class="ssh-transfer-meta" v-text="`${item.progress}%`" />
        <span class="ssh-transfer-meta"
          :class="{ 'is-success': item.status === 'done', 'is-failed': item.status === 'failed' }"
          v-text="item.progressLabel" />
      </div>
    </article>
  </div>
</template>
