<script setup lang="ts">
import { MoreHorizontal, Plus } from '@lucide/vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import type { ISnippetItem } from './run-sidebar.types';
import { getIcon } from './templateIconMap';

const props = defineProps<{
  /** 片段数据 */
  item: ISnippetItem;
}>();

const emit = defineEmits<{
  /** 将片段插入到编辑器光标处 */
  insert: [item: ISnippetItem];
  /** 在该片段上打开上下文菜单 */
  'context-menu': [event: MouseEvent, item: ISnippetItem];
}>();
</script>

<template>
  <div class="template-snip" @click="emit('insert', props.item)">
    <LucideIcon :name="getIcon(item.icon)" class="template-snip-ic" />
    <span class="template-snip-trigger">{{ item.trigger }}</span>
    <span class="template-snip-desc">{{ item.description }}</span>
    <span class="template-snip-actions">
      <button class="template-snip-btn" title="插入到光标" @click.stop="emit('insert', props.item)">
        <Plus class="template-snip-btn-svg" />
      </button>
      <button class="template-snip-btn" title="更多" @click.stop="emit('context-menu', $event, props.item)">
        <MoreHorizontal class="template-snip-btn-svg" />
      </button>
    </span>
  </div>
</template>

<style scoped>
.template-snip {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 5px 8px 5px 38px;
  text-align: left;
  cursor: pointer;
  position: relative;
  min-height: 30px;
  background: transparent;
  border: 0;
  font-family: inherit;
  transition: background 100ms ease;
}

.template-snip:hover {
  background: color-mix(in srgb, var(--surface-hover, #f1f1f2) 100%, transparent);
}

.template-snip:hover .template-snip-actions {
  opacity: 1;
}

.template-snip:hover .template-snip-ic {
  color: var(--phase-c, var(--text-secondary));
}

.template-snip:hover::before {
  content: "";
  position: absolute;
  left: 27px;
  top: 50%;
  width: 5px;
  height: 1px;
  background: var(--phase-c, var(--text-quaternary));
  transform: translateY(-50%);
}

.template-snip-ic {
  width: 13px;
  height: 13px;
  stroke-width: 1.75;
  flex-shrink: 0;
  color: var(--text-quaternary, #a1a1aa);
  transition: color 100ms ease;
}

.template-snip-trigger {
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
  color: var(--text-primary);
  font-weight: 500;
  flex-shrink: 0;
  min-width: 56px;
}

.template-snip-desc {
  font-size: 12px;
  color: var(--text-tertiary, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.template-snip-actions {
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 100ms ease;
  flex-shrink: 0;
}

.template-snip-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--text-tertiary, #71717a);
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  transition: all 100ms ease;
}

.template-snip-btn:hover {
  background: color-mix(in srgb, var(--surface-hover, #ebebec) 100%, transparent);
  color: var(--text-primary);
}

.template-snip-btn-svg {
  width: 12px;
  height: 12px;
  stroke-width: 2;
}

@media (prefers-reduced-motion: reduce) {

  .template-snip,
  .template-snip-ic,
  .template-snip-actions,
  .template-snip-btn {
    transition: none;
  }
}
</style>
