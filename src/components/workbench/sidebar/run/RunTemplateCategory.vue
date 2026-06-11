<script setup lang="ts">
import { ChevronRight } from '@lucide/vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import RunTemplateCard from './RunTemplateCard.vue';
import type { ISnippetCategory, ISnippetItem } from './run-sidebar.types';
import { getIcon } from './templateIconMap';

defineProps<{
  /** 当前类别数据 */
  category: ISnippetCategory;
  /** 所属阶段的主题色，用于派生竖向引导线与悬停高亮 */
  color: string;
  /** 是否展开 */
  open: boolean;
}>();

const emit = defineEmits<{
  /** 切换展开 / 折叠 */
  toggle: [];
  /** 透传：插入某个片段 */
  insert: [item: ISnippetItem];
  /** 透传：在某个片段上打开上下文菜单 */
  'context-menu': [event: MouseEvent, item: ISnippetItem];
}>();
</script>

<template>
  <div class="template-cat" :class="{ 'template-cat--open': open }" :style="{ '--phase-c': color }">
    <button class="template-cat-row" @click="emit('toggle')">
      <ChevronRight class="template-chev" />
      <span class="template-cat-icon">
        <LucideIcon :name="getIcon(category.icon)" class="template-cat-svg" />
      </span>
      <span class="template-cat-name">
         category.name 
        <span v-if="category.isNew" class="template-cat-new">新</span>
      </span>
      <span class="template-cat-badge"> category.items.length </span>
    </button>

    <!-- 片段列表 -->
    <div class="template-snips">
      <RunTemplateCard
        v-for="item in category.items"
        :key="item.trigger"
        :item="item"
        @insert="emit('insert', $event)"
        @context-menu="(menuEvent, menuItem) => emit('context-menu', menuEvent, menuItem)"
      />
    </div>
  </div>
</template>

<style scoped>
.template-cat {
  position: relative;
}

.template-cat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px 6px 14px;
  font-size: 13px;
  color: var(--text-secondary, #3f3f46);
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  transition: background 100ms ease;
}

.template-cat-row:hover {
  background: color-mix(in srgb, var(--surface-hover, #f1f1f2) 100%, transparent);
}

.template-chev {
  width: 11px;
  height: 11px;
  stroke-width: 2.25;
  flex-shrink: 0;
  color: var(--text-quaternary, #a1a1aa);
  transition: transform 140ms ease;
}

.template-cat--open>.template-cat-row .template-chev {
  transform: rotate(90deg);
}

.template-cat-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--phase-c, var(--text-tertiary));
}

.template-cat-svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.75;
}

.template-cat-name {
  flex: 1;
  text-align: left;
  font-weight: 500;
}

.template-cat-badge {
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-quaternary, #a1a1aa);
  font-variant-numeric: tabular-nums;
}

.template-cat-new {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  color: var(--accent-strong, #6366f1);
  padding: 1px 5px;
  background: color-mix(in srgb, var(--accent-strong, #6366f1) 14%, transparent);
  border-radius: 3px;
  margin-left: 4px;
  letter-spacing: 0.04em;
  vertical-align: middle;
}

.template-snips {
  display: none;
  padding: 2px 0 4px;
  position: relative;
}

.template-cat--open>.template-snips {
  display: block;
}

.template-cat--open>.template-snips::before {
  content: "";
  position: absolute;
  left: 27px;
  top: 0;
  bottom: 4px;
  width: 1px;
  background: var(--shell-divider, #d4d4d8);
}

@media (prefers-reduced-motion: reduce) {

  .template-chev,
  .template-cat-row {
    transition: none;
  }
}
</style>
