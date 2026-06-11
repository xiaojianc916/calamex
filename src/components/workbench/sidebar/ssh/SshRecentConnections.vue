<script setup lang="ts">
import { Clock3 } from '@lucide/vue';
import type { ISshRecentConnection } from '@/types/ssh';

defineProps<{
  connections: ISshRecentConnection[];
}>();

const emit = defineEmits<{
  select: [connection: ISshRecentConnection];
}>();
</script>

<template>
  <section class="ssh-recent-section ssh-recent-section--disconnected" aria-label="最近使用 SSH 连接">
    <div class="ssh-recent-title ssh-recent-title--disconnected">最近使用</div>

    <div v-if="connections.length === 0" class="ssh-recent-empty">
      暂无真实连接记录，可新建连接。
    </div>

    <button v-for="connection in connections" :key="connection.id" type="button"
      class="ssh-recent-item ssh-recent-item--disconnected" @click="emit('select', connection)">
      <span class="ssh-recent-icon ssh-recent-icon--disconnected" aria-hidden="true">
        <Clock3 />
      </span>

      <span class="ssh-recent-info">
        <span class="ssh-recent-name ssh-recent-name--disconnected"
          v-text="`${connection.username} @ ${connection.host}`" />
      </span>

      <span class="ssh-recent-time ssh-recent-time--disconnected" v-text="connection.lastUsedLabel" />
    </button>
  </section>
</template>
