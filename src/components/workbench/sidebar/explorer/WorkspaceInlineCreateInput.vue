<template>
  <input
    class="explorer-inline-create-input"
    :value="value"
    :placeholder="placeholder"
    type="text"
    aria-label="新建文件或文件夹"
    @pointerdown.stop
    @click.stop
    @contextmenu.stop
    @input="onInput"
    @blur="emit('blur')"
    @keydown.enter.prevent.stop="emit('confirm')"
    @keydown.esc.prevent.stop="emit('cancel')"
  />
</template>

<script setup lang="ts">
defineProps<{
  value: string;
  placeholder?: string;
}>();

const emit = defineEmits<{
  input: [value: string];
  blur: [];
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
 * 内联“新建文件/文件夹”输入框：与重命名输入框保持一致的轻量样式。
 * 高度固定 20px，去掉撑大的实心边框盒，改用 1px 描边 box-shadow，
 * flex 自适应宽度，避免新建时把整行撑高。
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
</style>
