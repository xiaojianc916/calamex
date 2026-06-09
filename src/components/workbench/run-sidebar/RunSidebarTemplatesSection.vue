<script setup lang="ts">
import {
  Check,
  ChevronRight,
  Copy,
  Eye,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
} from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import {
  type IPhase,
  type ISnippetCategory,
  type ISnippetItem,
  TEMPLATE_PHASES,
  type TPhaseId,
} from '@/components/workbench/run-sidebar/templateCatalog';

// ═══════════════════════════════════════════════
// 图标映射（值为 Tailwind mask 类名）
// ═══════════════════════════════════════════════
const iconMap: Record<string, string> = {
  // 类别图标
  star: 'star',
  clock: 'clock',
  rocket: 'rocket',
  'book-open': 'book-open',
  terminal: 'terminal',
  settings: 'settings',
  'shield-check': 'shield-check',
  lock: 'lock',
  type: 'type',
  braces: 'braces',
  calendar: 'calendar',
  database: 'database',
  'message-square': 'message-square',
  list: 'list',
  loader: 'loader',
  'file-text': 'file-text',
  'git-branch': 'git-branch',
  folder: 'folder',
  'file-search': 'file-search',
  cpu: 'cpu',
  globe: 'globe',
  'bar-chart-2': 'chart-bar', // ChartBar
  bell: 'bell',
  'alert-triangle': 'alert-triangle',
  'trash-2': 'trash-2',
  'log-out': 'log-out',
  bug: 'bug',
  shield: 'shield',
  'test-tube': 'test-tube',
  // 片段图标
  info: 'info',
  'rotate-cw': 'rotate-cw',
  'refresh-cw': 'refresh-cw',
  hash: 'hash',
  tag: 'tag',
  'help-circle': 'help-circle',
  flag: 'flag',
  'arrow-right': 'arrow-right',
  key: 'key',
  layers: 'layers',
  file: 'file',
  search: 'search',
  package: 'package',
  monitor: 'monitor',
  'user-check': 'user-check',
  'hard-drive': 'hard-drive',
  scissors: 'scissors',
  'arrow-down-az': 'arrow-down-a-z', // 路径是 a-z
  'arrow-up-az': 'arrow-up-a-z', // 路径是 a-z
  replace: 'replace',
  'text-cursor-input': 'text-cursor-input',
  'at-sign': 'at-sign',
  brackets: 'brackets',
  repeat: 'repeat',
  'git-branch-plus': 'git-branch-plus',
  combine: 'combine',
  'calendar-minus': 'calendar-minus',
  'calendar-clock': 'calendar-clock',
  filter: 'filter',
  wrench: 'wrench',
  'arrow-left-right': 'arrow-left-right',
  'mouse-pointer': 'mouse-pointer',
  'chevron-right': 'chevron-right',
  'list-ordered': 'list-ordered',
  'octagon-alert': 'octagon-alert',
  save: 'save',
  'timer-off': 'timer-off',
  'git-fork': 'git-fork',
  'file-check': 'file-check',
  'file-plus': 'file-plus',
  'file-clock': 'file-clock',
  'file-x': 'file-x',
  copy: 'copy',
  ruler: 'ruler',
  table: 'table-2', // Table2
  'arrow-up-down': 'arrow-up-down',
  cone: 'cone',
  ban: 'ban',
  send: 'send',
  plug: 'plug',
  mail: 'mail',
  webhook: 'webhook',
  'message-circle': 'message-circle',
  'bell-ring': 'bell-ring',
  skull: 'skull',
  asterisk: 'asterisk',
  broom: 'brush', // Brush
  'folder-x': 'folder-x',
  'undo-2': 'undo-2',
  code: 'code-xml', // CodeXml
  'terminal-square': 'square-terminal', // SquareTerminal
  'eye-off': 'eye-off',
  equal: 'equal',
  'grid-3x3': 'grid-3x3',
  'file-code': 'file-code',
  check: 'check',
  'shield-alert': 'alert-triangle', // 近似
  regex: 'brackets', // 近似
  'text-cursor': 'text-cursor-input', // 近似
  'bar-chart': 'chart-bar', // ChartBar
  pipeline: 'file', // 近似
};

function getIcon(name: string): string {
  return iconMap[name] ?? 'file-code';
}

// ═══════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════
const searchQuery = ref('');
const expandedCategoryKeys = ref<Set<string>>(new Set());
const contextMenuOpen = ref(false);
const contextMenuPos = ref({ x: 0, y: 0 });
const contextMenuTarget = ref<ISnippetItem | null>(null);
const toastVisible = ref(false);
const toastMessage = ref('');
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ── 搜索 ──
const normalizeText = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim();

const normalizedQuery = computed(() => normalizeText(searchQuery.value));

function snippetMatchesQuery(
  item: ISnippetItem,
  _category: ISnippetCategory,
  phase: IPhase,
): boolean {
  if (normalizedQuery.value.length === 0) return true;
  const searchText = normalizeText(
    [item.trigger, item.description, phase.label, _category.name].join(' '),
  );
  return searchText.includes(normalizedQuery.value);
}

// ── 可见的阶段（搜索过滤后） ──
const visiblePhases = computed(() =>
  TEMPLATE_PHASES.map((phase) => {
    // "我的" 阶段不在搜索中过滤
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

// ═══════════════════════════════════════════════
// 右键菜单
// ═══════════════════════════════════════════════
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

// ═══════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════
function showToast(message: string): void {
  toastMessage.value = message;
  toastVisible.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastVisible.value = false;
  }, 1500);
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

onMounted(() => {
  document.addEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('click', handleDocumentClick);
});

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer);
  document.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('click', handleDocumentClick);
});
</script>

<template>
  <section class="template-sidebar" aria-label="Shell 片段库">
    <!-- ═══ Header ═══ -->
    <div class="template-header">
      <div class="template-title-row">

      </div>

      <div class="template-search-row">
        <Search class="template-search-icon" />
        <input ref="searchInputRef" v-model="searchQuery" type="text" placeholder="搜索触发词或描述" />
      </div>
    </div>

    <!-- ═══ 树形列表 ═══ -->
    <div class="template-scroll">
      <template v-for="(phase, _phaseIdx) in visiblePhases" :key="phase.id">
        <!-- 横切分隔线 -->
        <div v-if="phase.id === 'cro'" class="template-divider">
          <span>横切 · Cross-cutting</span>
        </div>
        <!-- 阶段标签 -->
        <div v-else class="template-phase-label" :style="{ '--phase-c': phase.color }">
          <span class="template-phase-dot"></span>
          {{ phase.label }}
        </div>

        <!-- 类别列表 -->
        <div v-for="(cat, catIdx) in phase.categories" :key="`${phase.id}-${catIdx}`" class="template-cat" :class="{
          'template-cat--open': isCategoryOpen(phase.id, catIdx),
        }" :style="{ '--phase-c': phase.color }">
          <button class="template-cat-row" @click="toggleCategory(phase.id, catIdx)">
            <ChevronRight class="template-chev" />
            <span class="template-cat-icon">
              <LucideIcon :name="getIcon(cat.icon)" class="template-cat-svg" />
            </span>
            <span class="template-cat-name">
              {{ cat.name }}
              <span v-if="cat.isNew" class="template-cat-new">新</span>
            </span>
            <span class="template-cat-badge">{{ cat.items.length }}</span>
          </button>

          <!-- 片段列表 -->
          <div class="template-snips">
            <div v-for="item in cat.items" :key="`${phase.id}-${catIdx}-${item.trigger}`" class="template-snip"
              @click="handleSnippetClick(item)">
              <LucideIcon :name="getIcon(item.icon)" class="template-snip-ic" />
              <span class="template-snip-trigger">{{ item.trigger }}</span>
              <span class="template-snip-desc">{{ item.description }}</span>
              <span class="template-snip-actions">
                <button class="template-snip-btn" title="插入到光标" @click.stop="handleSnippetClick(item)">
                  <Plus class="template-snip-btn-svg" />
                </button>
                <button class="template-snip-btn" title="更多" @click.stop="openContextMenu($event, item)">
                  <MoreHorizontal class="template-snip-btn-svg" />
                </button>
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- ═══ 右键菜单 ═══ -->
    <Teleport to="body">
      <div id="template-context-menu" class="template-menu" :class="{ 'template-menu--on': contextMenuOpen }" :style="{
        left: contextMenuPos.x + 'px',
        top: contextMenuPos.y + 'px',
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
        <span>{{ toastMessage }}</span>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ═══════════════════════════════════════════════════════
   Shell 片段库侧栏
   ═══════════════════════════════════════════════════════ */

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

.template-title-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent-strong, #6366f1) 14%, transparent);
  color: var(--accent-strong, #6366f1);
}

.template-title-svg {
  width: 14px;
  height: 14px;
  stroke-width: 1.75;
}

.template-title-text {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.template-title-count {
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-quaternary, #a1a1aa);
  font-variant-numeric: tabular-nums;
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

.template-kbd {
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-quaternary, #a1a1aa);
  padding: 1px 5px;
  border: 1px solid var(--shell-divider, #e4e4e7);
  border-radius: 3px;
  background: #fafafa;
  flex-shrink: 0;
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

/* ── 类别行 ── */
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

/* ── 片段列表 + 竖向引导线 ── */
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

/* ── 片段行 ── */
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

/* ── Footer ── */
.template-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid var(--shell-divider, #e4e4e7);
  font-size: 11px;
  color: var(--text-quaternary, #a1a1aa);
}

.template-foot-hint {
  display: flex;
  align-items: center;
  gap: 6px;
}

.template-foot-icon {
  width: 12px;
  height: 12px;
  stroke-width: 2;
}

/* ── 右键菜单 ── */
.template-menu {
  position: fixed;
  min-width: 184px;
  padding: 4px;
  background: #fafafa;
  border: 1px solid var(--shell-divider, #e4e4e7);
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
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text-secondary, #3f3f46);
  border-radius: 4px;
  text-align: left;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  transition: background 80ms ease, color 80ms ease;
}

.template-menu-item:hover {
  background: color-mix(in srgb, var(--surface-hover, #f1f1f2) 100%, transparent);
  color: var(--text-primary);
}

.template-menu-icon {
  width: 13px;
  height: 13px;
  stroke-width: 1.75;
  color: var(--text-tertiary, #71717a);
}

.template-menu-item:hover .template-menu-icon {
  color: var(--text-primary);
}

.template-menu-item--danger {
  color: #ef4444;
}

.template-menu-item--danger .template-menu-icon {
  color: #ef4444;
}

.template-menu-item--danger:hover {
  background: #fef2f2;
}

.template-menu-kbd {
  margin-left: auto;
  font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  color: var(--text-quaternary, #a1a1aa);
}

.template-menu-sep {
  height: 1px;
  background: var(--shell-divider, #e4e4e7);
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
  .template-chev,
  .template-cat-row,
  .template-snip,
  .template-snip-ic,
  .template-snip-actions,
  .template-snip-btn,
  .template-menu,
  .template-menu-item,
  .template-toast {
    transition: none;
  }
}
</style>
