<script setup lang="ts">
import { Check, Copy, Eye, Pencil, Pin, Plus, Search, Trash2 } from '@lucide/vue';
import { useEventListener, useTimeoutFn } from '@vueuse/core';
import { computed, ref } from 'vue';
import RunTemplateCategory from './RunTemplateCategory.vue';
import {
  type IPhase,
  type ISnippetCategory,
  type ISnippetItem,
  TEMPLATE_PHASES,
  type TPhaseId,
} from './templateCatalog';

// ═══════════════
// 状态
// ═══════════════
const searchQuery = ref('');
const expandedCategoryKeys = ref<Set<string>>(new Set());
const contextMenuOpen = ref(false);
const contextMenuPos = ref({ x: 0, y: 0 });
const contextMenuTarget = ref<ISnippetItem | null>(null);
const toastVisible = ref(false);
const toastMessage = ref('');
// 1.5s 后自动隐藏 toast；immediate: false 仅在 showToast 时手动 start。
const { start: scheduleToastHide } = useTimeoutFn(
  () => {
    toastVisible.value = false;
  },
  1500,
  { immediate: false },
);

// ── 搜索 ──
const normalizeText = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim();

const normalizedQuery = computed(() => normalizeText(searchQuery.value));

function snippetMatchesQuery(
  item: ISnippetItem,
  category: ISnippetCategory,
  phase: IPhase,
): boolean {
  if (normalizedQuery.value.length === 0) return true;
  const searchText = normalizeText(
    [item.trigger, item.description, phase.label, category.name].join(' '),
  );
  return searchText.includes(normalizedQuery.value);
}

// ── 可见的阶段（搜索过滤后） ──
const visiblePhases = computed(() =>
  TEMPLATE_PHASES.map((phase) => {
    // “我的” 阶段不在搜索中过滤
    if (phase.id === 'mine') return phase;
    const filteredCategories = phase.categories
      .map((cat) => ({
        ...cat,
        items: cat.items.filter((item) => snippetMatchesQuery(item, cat, phase)),
      }))
      .filter((cat) => normalizedQuery.value.length === 0 || cat.items.length > 0);
    return { ...phase, categories: filteredCategories };
  }).filter((phase) => {
    if (phase.id === 'mine') return true;
    return normalizedQuery.value.length === 0 || phase.categories.length > 0;
  }),
);

// ── 类别展开 / 折叠 ──
function categoryKey(phaseId: TPhaseId, catIndex: number): string {
  return `${phaseId}::${catIndex}`;
}

function isCategoryOpen(phaseId: TPhaseId, catIndex: number): boolean {
  if (normalizedQuery.value.length > 0) return true;
  return expandedCategoryKeys.value.has(categoryKey(phaseId, catIndex));
}

function toggleCategory(phaseId: TPhaseId, catIndex: number): void {
  const key = categoryKey(phaseId, catIndex);
  const next = new Set(expandedCategoryKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  expandedCategoryKeys.value = next;
}

// ═══════════════
// 右键菜单
// ═══════════════
function openContextMenu(event: MouseEvent, item: ISnippetItem): void {
  event.stopPropagation();
  event.preventDefault();
  contextMenuTarget.value = item;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  let left = rect.right - 184;
  let top = rect.bottom + 4;
  if (top + 280 > window.innerHeight) top = rect.top - 280;
  if (left < 8) left = 8;
  contextMenuPos.value = { x: left, y: top };
  contextMenuOpen.value = true;
}

function closeContextMenu(): void {
  contextMenuOpen.value = false;
  contextMenuTarget.value = null;
}

function handleMenuAction(action: string): void {
  if (!contextMenuTarget.value) return;
  const trigger = contextMenuTarget.value.trigger;
  const messages: Record<string, string> = {
    insert: `已插入 ${trigger} → 光标`,
    'copy-trigger': `已复制触发词 ${trigger}`,
    'copy-code': `已复制 ${trigger} 完整代码`,
    pin: `${trigger} 已钉到收藏`,
    view: `打开 ${trigger} 详情`,
    edit: `编辑 ${trigger}`,
    delete: `已删除 ${trigger}`,
  };
  showToast(messages[action] ?? '');
  closeContextMenu();
}

// ═══════════════
// Toast
// ═══════════════
function showToast(message: string): void {
  toastMessage.value = message;
  toastVisible.value = true;
  scheduleToastHide();
}

// ── 片段点击（直接插入） ──
function handleSnippetClick(item: ISnippetItem): void {
  showToast(`已插入 ${item.trigger} → 光标`);
}

// ── 键盘快捷键 ──
const searchInputRef = ref<HTMLInputElement | null>(null);

function handleGlobalKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'p') {
    event.preventDefault();
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
    return;
  }
  if (event.key === 'Escape') {
    closeContextMenu();
    if (document.activeElement === searchInputRef.value) {
      searchQuery.value = '';
      searchInputRef.value?.blur();
    }
  }
}

// ── 点击外部关闭菜单 ──
function handleDocumentClick(event: MouseEvent): void {
  const menuEl = document.getElementById('template-context-menu');
  if (menuEl && !menuEl.contains(event.target as Node)) {
    closeContextMenu();
  }
}

useEventListener(document, 'keydown', handleGlobalKeydown);
useEventListener(document, 'click', handleDocumentClick);
</script>

<template>
  <section class="template-sidebar" aria-label="Shell 片段库">
    <!-- ═══ Header ═══ -->
    <div class="template-header">
      <div class="template-title-row"></div>

      <div class="template-search-row">
        <Search class="template-search-icon" />
        <input ref="searchInputRef" v-model="searchQuery" type="text" placeholder="搜索触发词或描述" />
      </div>
    </div>

    <!-- ═══ 树形列表 ═══ -->
    <div class="template-scroll">
      <template v-for="phase in visiblePhases" :key="phase.id">
        <!-- 横切分隔线 -->
        <div v-if="phase.id === 'cro'" class="template-divider">
          <span>横切 · Cross-cutting</span>
        </div>
        <!-- 阶段标签 -->
        <div v-else class="template-phase-label" :style="{ '--phase-c': phase.color }">
          <span class="template-phase-dot"></span>
           phase.label 
        </div>

        <!-- 类别列表 -->
        <RunTemplateCategory
          v-for="(cat, catIdx) in phase.categories"
          :key="`${phase.id}-${catIdx}`"
          :category="cat"
          :color="phase.color"
          :open="isCategoryOpen(phase.id, catIdx)"
          @toggle="toggleCategory(phase.id, catIdx)"
          @insert="handleSnippetClick"
          @context-menu="openContextMenu"
        />
      </template>
    </div>

    <!-- ═══ 右键菜单 ═══ -->
    <Teleport to="body">
      <div id="template-context-menu" class="template-menu" :class="{ 'template-menu--on': contextMenuOpen }" :style="{
        left: `${contextMenuPos.x}px`,
        top: `${contextMenuPos.y}px`,
      }">
        <button class="template-menu-item" @click="handleMenuAction('insert')">
          <Plus class="template-menu-icon" />
          插入到光标
          <span class="template-menu-kbd">↵</span>
        </button>
        <button class="template-menu-item" @click="handleMenuAction('copy-trigger')">
          <Copy class="template-menu-icon" />
          复制触发词
        </button>
        <button class="template-menu-item" @click="handleMenuAction('copy-code')">
          <Copy class="template-menu-icon" />
          复制完整代码
        </button>
        <div class="template-menu-sep"></div>
        <button class="template-menu-item" @click="handleMenuAction('pin')">
          <Pin class="template-menu-icon" />
          钉到收藏
        </button>
        <button class="template-menu-item" @click="handleMenuAction('view')">
          <Eye class="template-menu-icon" />
          在编辑器中查看
        </button>
        <button class="template-menu-item" @click="handleMenuAction('edit')">
          <Pencil class="template-menu-icon" />
          编辑片段
        </button>
        <div class="template-menu-sep"></div>
        <button class="template-menu-item template-menu-item--danger" @click="handleMenuAction('delete')">
          <Trash2 class="template-menu-icon" />
          删除
        </button>
      </div>
    </Teleport>

    <!-- ═══ Toast ═══ -->
    <Teleport to="body">
      <div class="template-toast" :class="{ 'template-toast--on': toastVisible }">
        <Check class="template-toast-icon" />
        <span> toastMessage </span>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ═══════════════════════
   Shell 片段库侧栏（协调器外壳）
   ═══════════════════════ */

.template-sidebar {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  color: var(--text-primary);
  background: #fafafa;
  -webkit-font-smoothing: antialiased;
}

/* ── Header ── */
.template-header {
  padding: 12px;
  border-bottom: 1px solid var(--shell-divider, #e4e4e7);
}

.template-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 10px;
}

/* ── 搜索 ── */
.template-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  background: color-mix(in srgb, var(--surface-hover, #f1f1f2) 100%, transparent);
  border-radius: 6px;
  cursor: text;
  transition: box-shadow 140ms ease;
}

.template-search-row:focus-within {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-strong, #6366f1) 18%, transparent);
}

.template-search-icon {
  width: 13px;
  height: 13px;
  stroke-width: 1.75;
  flex-shrink: 0;
  color: var(--text-quaternary, #a1a1aa);
}

.template-search-row input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
}

.template-search-row input::placeholder {
  color: var(--text-quaternary, #a1a1aa);
}

/* ── 滚动区 ── */
.template-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0 8px;
}

.template-scroll::-webkit-scrollbar {
  width: 6px;
}

.template-scroll::-webkit-scrollbar-thumb {
  background: var(--shell-divider, #e4e4e7);
  border-radius: 3px;
}

.template-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--text-quaternary, #a1a1aa);
}

/* ── 阶段标签 ── */
.template-phase-label {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px 14px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-quaternary, #a1a1aa);
  text-transform: uppercase;
}

.template-phase-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--phase-c, var(--text-quaternary));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--phase-c, var(--text-quaternary)) 18%, transparent);
}

/* ── 区段分隔（横切） ── */
.template-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 14px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-quaternary, #a1a1aa);
  text-transform: uppercase;
}

.template-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--shell-divider, #e4e4e7);
}

/* ── 右键菜单（对齐编辑器右键菜单 LinearContextMenu 样式） ── */
.template-menu {
  position: fixed;
  min-width: 208px;
  padding: 4px;
  background: #ffffff;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04);
  z-index: 200;
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
  transform-origin: top right;
  transition: all 120ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
}

.template-menu--on {
  opacity: 1;
  transform: scale(1) translateY(0);
  pointer-events: auto;
}

.template-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  font-size: 14px;
  color: #1f1f1f;
  border-radius: 4px;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  transition: background 80ms ease, color 80ms ease;
}

.template-menu-item:hover {
  background: #f5f5f5;
  color: #1f1f1f;
}

.template-menu-icon {
  width: 16px;
  height: 16px;
  stroke-width: 1.75;
  color: #1f1f1f;
}

.template-menu-item:hover .template-menu-icon {
  color: #1f1f1f;
}

.template-menu-item--danger {
  color: #ef4444;
}

.template-menu-item--danger .template-menu-icon {
  color: #ef4444;
}

.template-menu-item--danger:hover {
  background: #fef2f2;
  color: #ef4444;
}

.template-menu-kbd {
  margin-left: auto;
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  color: #666666;
}

.template-menu-sep {
  height: 1px;
  background: #eeeeee;
  margin: 4px 0;
}

/* ── Toast ── */
.template-toast {
  position: fixed;
  left: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--text-primary);
  color: var(--bg-0, #fafafa);
  font-size: 12px;
  border-radius: 6px;
  opacity: 0;
  transform: translateY(10px);
  transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
  pointer-events: none;
  z-index: 300;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.template-toast--on {
  opacity: 1;
  transform: translateY(0);
}

.template-toast-icon {
  width: 13px;
  height: 13px;
  stroke-width: 1.75;
  color: #84cc16;
}

/* ── 动效减弱 ── */
@media (prefers-reduced-motion: reduce) {

  .template-search-row,
  .template-menu,
  .template-menu-item,
  .template-toast {
    transition: none;
  }
}
</style>
