<template>
  <input
    class="explorer-inline-create-input explorer-inline-rename-input"
    type="text"
    aria-label="重命名文件"
    :value="value"
    @input="onInput"
    @blur="emit('confirm')"
    @pointerdown.stop
    @click.stop
    @keydown.enter.prevent.stop="emit('confirm')"
    @keydown.esc.prevent.stop="emit('cancel')"
  />
</template>

<script setup lang="ts">
defineProps<{
  value: string;
}>();

const emit = defineEmits<{
  input: [value: string];
  confirm: [];
  cancel: [];
}>();

const onInput = (event: Event): void => {
  if (event.target instanceof HTMLInputElement) {
    emit('input', event.target.value);
  }
};
</script>

<style scoped>
/*
 * 重命名输入框元素同时带有 explorer-inline-create-input 与
 * explorer-inline-rename-input 两个 class，这里同时声明两套规则，
 * 确保拆分后渲染与原内联实现完全一致（白色主题，硬编码颜色按既有要求保留）。
 */
.explorer-inline-create-input {
  flex: 1;
  width: auto;
  min-width: 0;
  height: 20px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: #ffffff;
  color: #1f2328;
  font-size: 13px;
  line-height: 20px;
  outline: none;
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.18);
  transition: box-shadow 120ms ease;
}

.explorer-inline-create-input:hover {
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.32);
}

.explorer-inline-create-input:focus {
  box-shadow:
    0 0 0 1px #4493f8,
    0 0 0 3px rgba(68, 147, 248, 0.2);
}

.explorer-inline-rename-input {
  flex: 1;
  width: auto;
  min-width: 0;
  height: 20px;
  margin: 0;
  padding: 0 6px;
  border: 0;
  border-radius: 5px;
  background: #ffffff;
  color: #1f2328;
  font-size: 13px;
  line-height: 20px;
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.18);
}

.explorer-inline-rename-input:hover {
  box-shadow: 0 0 0 1px rgba(31, 35, 40, 0.32);
}

.explorer-inline-rename-input:focus {
  box-shadow:
    0 0 0 1px #4493f8,
    0 0 0 3px rgba(68, 147, 248, 0.2);
}
</style>
