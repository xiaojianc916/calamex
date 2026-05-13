<script setup lang="ts">
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
    RUN_OPS_TEMPLATE_BLUEPRINTS,
    RUN_OPS_TEMPLATE_CATEGORIES,
    type IRunOpsTemplateBlueprint,
    type TRunOpsTemplateCategoryId,
    type TRunOpsTemplateRisk,
} from '@/components/workbench/run-sidebar/runOpsTemplateCatalog';
import {
    ChevronRight,
    Clock3,
    FileCode,
    FolderClosed,
    FolderOpen,
    Layers3,
    Search,
    ShieldCheck,
} from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';

interface ICategoryFolder {
  id: TRunOpsTemplateCategoryId;
  title: string;
  summary: string;
  templates: IRunOpsTemplateBlueprint[];
}

const expandedCategoryIds = ref<Set<TRunOpsTemplateCategoryId>>(new Set());
const searchQuery = ref('');
const selectedTemplateId = ref(RUN_OPS_TEMPLATE_BLUEPRINTS[0]?.id ?? '');

const normalizeSearchText = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim();

const categoryTitleMap = computed<Record<TRunOpsTemplateCategoryId, string>>(() =>
  RUN_OPS_TEMPLATE_CATEGORIES.reduce<Record<TRunOpsTemplateCategoryId, string>>(
    (result, category) => ({
      ...result,
      [category.id]: category.title,
    }),
    {} as Record<TRunOpsTemplateCategoryId, string>,
  ),
);

const normalizedQuery = computed(() => normalizeSearchText(searchQuery.value));

const buildTemplateSearchText = (template: IRunOpsTemplateBlueprint): string =>
  normalizeSearchText([
    template.title,
    template.summary,
    template.fit,
    template.trigger,
    template.dependencies.join(' '),
    categoryTitleMap.value[template.categoryId],
  ].join(' '));

const categoryFolders = computed<ICategoryFolder[]>(() =>
  RUN_OPS_TEMPLATE_CATEGORIES.map((category) => {
    const templates = RUN_OPS_TEMPLATE_BLUEPRINTS.filter((template) => {
      const matchCategory = template.categoryId === category.id;
      const matchQuery =
        normalizedQuery.value.length === 0 || buildTemplateSearchText(template).includes(normalizedQuery.value);

      return matchCategory && matchQuery;
    });

    return {
      id: category.id,
      title: category.title,
      summary: category.summary,
      templates,
    };
  }).filter((category) => normalizedQuery.value.length === 0 || category.templates.length > 0),
);

const filteredTemplates = computed<IRunOpsTemplateBlueprint[]>(() =>
  categoryFolders.value.flatMap((category) => category.templates),
);

watch(
  filteredTemplates,
  (templates) => {
    if (templates.length === 0) {
      selectedTemplateId.value = '';
      return;
    }

    if (!templates.some((template) => template.id === selectedTemplateId.value)) {
      selectedTemplateId.value = templates[0].id;
    }
  },
  { immediate: true },
);

const isCategoryOpen = (categoryId: TRunOpsTemplateCategoryId): boolean => {
  if (normalizedQuery.value.length > 0) {
    return true;
  }

  return expandedCategoryIds.value.has(categoryId);
};

const setCategoryOpen = (categoryId: TRunOpsTemplateCategoryId, open: boolean): void => {
  const nextCategoryIds = new Set(expandedCategoryIds.value);
  if (open) {
    nextCategoryIds.add(categoryId);
  } else {
    nextCategoryIds.delete(categoryId);
  }

  expandedCategoryIds.value = nextCategoryIds;
};

const selectTemplate = (templateId: string): void => {
  selectedTemplateId.value = templateId;
};

const getRiskLabel = (risk: TRunOpsTemplateRisk): string => {
  switch (risk) {
    case 'readonly':
      return '只读';
    case 'write':
      return '写操作';
    case 'destructive':
      return '破坏性';
  }
};
</script>

<template>
  <section class="ops-template-shell" aria-label="Shell 运维脚本模板">
    <header class="ops-template-header">
      <div class="ops-template-heading">
        <p class="ops-template-eyebrow">Shell 运维模板</p>
        <h2 class="ops-template-title">生产脚本蓝图</h2>
      </div>

      <div class="ops-template-metrics" aria-label="模板库概览">
        <span>
          <Layers3 aria-hidden="true" />
          8 类
        </span>
        <span>
          <ShieldCheck aria-hidden="true" />
          6 项
        </span>
        <span>
          <Clock3 aria-hidden="true" />
          待编写
        </span>
      </div>
    </header>

    <label class="ops-template-search" aria-label="搜索脚本模板">
      <Search aria-hidden="true" />
      <input v-model="searchQuery" type="text" placeholder="搜索场景、依赖、能力">
    </label>

    <div class="ops-template-tree" aria-label="模板分类树">
      <Collapsible
v-for="category in categoryFolders" :key="category.id" :open="isCategoryOpen(category.id)"
        class="ops-template-folder" @update:open="setCategoryOpen(category.id, $event)">
        <CollapsibleTrigger as-child>
          <button type="button" class="ops-template-folder-trigger">
            <ChevronRight class="ops-template-folder-chevron" aria-hidden="true" />
            <FolderOpen v-if="isCategoryOpen(category.id)" class="ops-template-folder-icon" aria-hidden="true" />
            <FolderClosed v-else class="ops-template-folder-icon" aria-hidden="true" />

            <span class="ops-template-folder-main">
              <span class="ops-template-folder-title">{{ category.title }}</span>
            </span>

            <span class="ops-template-folder-count">{{ category.templates.length }}</span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent class="ops-template-folder-content">
          <div class="ops-template-file-list">
            <button
v-for="template in category.templates" :key="template.id" type="button"
              class="ops-template-file" :class="{ 'is-selected': selectedTemplateId === template.id }"
              :aria-pressed="selectedTemplateId === template.id" @click="selectTemplate(template.id)">
              <FileCode class="ops-template-file-icon" aria-hidden="true" />

              <span class="ops-template-file-main">
                <span class="ops-template-file-title">{{ template.title }}</span>
              </span>

              <span class="ops-template-file-meta">
                <span class="ops-template-risk" :data-risk="template.risk">
                  {{ getRiskLabel(template.risk) }}
                </span>
                <span class="ops-template-status">待写</span>
              </span>
            </button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div v-if="filteredTemplates.length === 0" class="ops-template-empty">
        没有匹配的模板蓝图
      </div>
    </div>

  </section>
</template>

<style scoped>
.ops-template-shell {
  --ops-space-1: 4px;
  --ops-space-2: 6px;
  --ops-space-3: 8px;
  --ops-space-4: 10px;
  --ops-space-5: 12px;
  --ops-space-6: 14px;
  --ops-radius-sm: var(--radius-sm);
  --ops-radius-md: var(--radius-md);
  --ops-font-xs: 10.5px;
  --ops-font-sm: 11.5px;
  --ops-font-md: 12.5px;
  --ops-font-lg: 14px;

  display: flex;
  min-height: 100%;
  flex-direction: column;
  gap: var(--ops-space-3);
  padding: var(--ops-space-5) var(--ops-space-5) var(--ops-space-6);
  color: var(--text-primary);
}

.ops-template-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--ops-space-4);
}

.ops-template-heading {
  min-width: 0;
}

.ops-template-eyebrow {
  margin: 0;
  color: var(--text-quaternary);
  font-size: var(--ops-font-xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.ops-template-title {
  margin: var(--ops-space-1) 0 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--ops-font-lg);
  font-weight: 650;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ops-template-metrics {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--ops-space-1);
  max-width: 148px;
}

.ops-template-metrics span {
  display: inline-flex;
  align-items: center;
  gap: var(--ops-space-1);
  min-height: 20px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 76%, transparent);
  border-radius: var(--ops-radius-sm);
  padding: 0 var(--ops-space-2);
  background: color-mix(in srgb, var(--panel-bg) 74%, transparent);
  color: var(--text-tertiary);
  font-size: var(--ops-font-xs);
  white-space: nowrap;
}

.ops-template-metrics svg {
  width: 12px;
  height: 12px;
}

.ops-template-search {
  display: flex;
  align-items: center;
  gap: var(--ops-space-2);
  min-height: 30px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 82%, transparent);
  border-radius: var(--ops-radius-md);
  padding: 0 var(--ops-space-3);
  background: color-mix(in srgb, var(--panel-bg) 72%, transparent);
  color: var(--text-tertiary);
  transition:
    border-color var(--motion-duration-fast) var(--motion-easing-standard),
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard);
}

.ops-template-search:focus-within {
  border-color: color-mix(in srgb, var(--accent-strong) 58%, var(--shell-divider));
  background: color-mix(in srgb, var(--panel-bg) 92%, transparent);
  color: var(--text-primary);
}

.ops-template-search svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.ops-template-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--ops-font-md);
}

.ops-template-search input::placeholder {
  color: var(--text-quaternary);
}

.ops-template-tree {
  display: flex;
  flex-direction: column;
  gap: var(--ops-space-2);
}

.ops-template-folder {
  border: 1px solid color-mix(in srgb, var(--shell-divider) 74%, transparent);
  border-radius: var(--ops-radius-md);
  background: color-mix(in srgb, var(--panel-bg) 60%, transparent);
}

.ops-template-folder-trigger {
  display: grid;
  grid-template-columns: 16px 16px minmax(0, 1fr) auto;
  gap: var(--ops-space-2);
  align-items: center;
  width: 100%;
  min-height: 42px;
  border-radius: calc(var(--ops-radius-md) - 1px);
  padding: var(--ops-space-2) var(--ops-space-3);
  color: var(--text-secondary);
  text-align: left;
  transition:
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ops-template-folder-trigger[data-state='open'] .ops-template-folder-chevron {
  transform: rotate(90deg);
}

.ops-template-folder-chevron,
.ops-template-folder-icon,
.ops-template-file-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.ops-template-folder-chevron {
  color: var(--text-quaternary);
  transition: transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ops-template-folder-icon {
  color: var(--accent-strong);
}

.ops-template-folder-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.ops-template-folder-title {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--ops-font-md);
  font-weight: 650;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ops-template-folder-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  min-height: 20px;
  border-radius: var(--ops-radius-sm);
  background: color-mix(in srgb, var(--surface-hover) 100%, transparent);
  color: var(--text-tertiary);
  font-size: var(--ops-font-xs);
  font-variant-numeric: tabular-nums;
}

.ops-template-folder-content {
  overflow: hidden;
}

.ops-template-file-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--ops-space-2) var(--ops-space-2) 34px;
}

.ops-template-file {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  gap: var(--ops-space-2);
  align-items: center;
  min-height: 46px;
  border: 1px solid transparent;
  border-radius: var(--ops-radius-sm);
  padding: var(--ops-space-2);
  color: var(--text-secondary);
  text-align: left;
  transition:
    border-color var(--motion-duration-fast) var(--motion-easing-standard),
    background-color var(--motion-duration-fast) var(--motion-easing-standard),
    color var(--motion-duration-fast) var(--motion-easing-standard),
    transform var(--motion-duration-fast) var(--motion-easing-standard);
}

.ops-template-file.is-selected {
  border-color: color-mix(in srgb, var(--accent-strong) 34%, var(--shell-divider));
  background: color-mix(in srgb, var(--accent-strong) 9%, transparent);
  color: var(--text-primary);
}

.ops-template-file-icon {
  color: var(--text-tertiary);
}

.ops-template-file.is-selected .ops-template-file-icon {
  color: var(--accent-strong);
}

.ops-template-file-main,
.ops-template-file-meta {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: var(--ops-space-1);
}

.ops-template-file-title {
  overflow: hidden;
  color: var(--text-primary);
  font-size: var(--ops-font-md);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ops-template-file-meta {
  align-items: flex-end;
}

.ops-template-folder-trigger:active,
.ops-template-file:active {
  transform: scale(0.985);
}

@media (hover: hover) and (pointer: fine) {

  .ops-template-folder-trigger:hover,
  .ops-template-file:hover {
    background: color-mix(in srgb, var(--surface-hover) 100%, transparent);
    color: var(--text-primary);
  }
}

.ops-template-risk,
.ops-template-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 20px;
  border: 1px solid color-mix(in srgb, var(--shell-divider) 78%, transparent);
  border-radius: var(--ops-radius-sm);
  padding: 0 var(--ops-space-2);
  color: var(--text-tertiary);
  font-size: var(--ops-font-xs);
  font-weight: 600;
  white-space: nowrap;
}

.ops-template-risk[data-risk='readonly'] {
  border-color: color-mix(in srgb, var(--success) 26%, var(--shell-divider));
  background: color-mix(in srgb, var(--success) 8%, transparent);
  color: var(--success);
}

.ops-template-risk[data-risk='write'] {
  border-color: color-mix(in srgb, var(--warning) 32%, var(--shell-divider));
  background: color-mix(in srgb, var(--warning) 9%, transparent);
  color: var(--warning);
}

.ops-template-risk[data-risk='destructive'] {
  border-color: color-mix(in srgb, var(--danger) 32%, var(--shell-divider));
  background: color-mix(in srgb, var(--danger) 9%, transparent);
  color: var(--danger);
}

.ops-template-status {
  color: var(--text-quaternary);
}

.ops-template-empty {
  padding: var(--ops-space-6) var(--ops-space-3);
  color: var(--text-quaternary);
  font-size: var(--ops-font-md);
  text-align: center;
}

@media (prefers-reduced-motion: reduce) {
  .ops-template-search,
  .ops-template-folder-chevron,
  .ops-template-folder-trigger,
  .ops-template-file {
    transition: none;
  }

  .ops-template-folder-trigger:active,
  .ops-template-file:active {
    transform: none;
  }
}
</style>
