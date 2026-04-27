<script setup lang="ts">
const emit = defineEmits<{
  select: [action: string];
}>();

const actions = [
  ['explain_selection', '解释选区'],
  ['rewrite_selection', '重写选区'],
  ['generate_tests', '生成测试'],
  ['fix_diagnostic', '修复诊断'],
] as const;
</script>

<template>
  <div class="ai-code-action-menu">
    <button v-for="action in actions" :key="action[0]" type="button" @click="emit('select', action[0])">
      {{ action[1] }}
    </button>
  </div>
</template>

<style scoped>
.ai-code-action-menu {
  display: grid;
  gap: 4px;
  border: 1px solid var(--shell-divider);
  border-radius: 8px;
  background: var(--panel-bg);
  padding: 5px;
}

.ai-code-action-menu button {
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 6px 8px;
  text-align: left;
}

.ai-code-action-menu button:hover {
  background: var(--surface-soft);
  color: var(--text-primary);
}
</style>
