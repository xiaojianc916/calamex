<template>
  <div class="search-panel-query-stack">
    <div class="search-panel-input-shell">
      <span class="search-panel-input-icon" aria-hidden="true">
        <Search />
      </span>

      <Input :model-value="searchQuery" class="search-panel-input" type="text" aria-label="搜索关键字"
        :placeholder="useStructural ? '输入 ast-grep 模式…' : '输入关键字搜索…'" autocomplete="off" spellcheck="false"
        @update:model-value="emit('update:searchQuery', $event)" />

      <button v-if="hasSearchQuery" type="button" class="search-panel-clear-btn" aria-label="清空搜索" title="清空搜索"
        @click.stop="emit('update:searchQuery', '')">
        <X aria-hidden="true" />
      </button>
    </div>

    <div class="search-panel-input-shell search-panel-replace-shell">
      <span class="search-panel-input-icon" aria-hidden="true">
        <Replace />
      </span>

      <Input :model-value="replacementQuery" class="search-panel-input" type="text" aria-label="替换内容"
        :placeholder="useStructural ? '输入 ast-grep 替换…' : '输入替换内容…'" autocomplete="off" spellcheck="false"
        @update:model-value="emit('update:replacementQuery', $event)" @keydown.enter="emit('replacement-action')" />

      <button type="button" class="search-panel-apply-btn" :disabled="!canApplyReplacement" aria-label="全部替换"
        title="全部替换" @click.stop="emit('replacement-action')">
        <LoaderCircle class="search-panel-spin" v-if="replaceRunning" aria-hidden="true" />
        <Check v-else aria-hidden="true" />
      </button>
    </div>
  </div>

  <div class="search-panel-chip-row">
    <button v-for="chip in scopeChips" :key="chip.key" type="button" class="search-panel-chip"
      :class="{ 'is-active': activeScope === chip.key }" :aria-pressed="activeScope === chip.key"
      @click="emit('update:activeScope', chip.key)">
      <span v-text="chip.label" />
      <span class="search-panel-chip-count" v-text="chip.count" />
    </button>
  </div>

  <div class="search-panel-option-row" aria-label="搜索选项">
    <button type="button" class="search-panel-option-btn" :class="{ 'is-active': matchCase }"
      :aria-pressed="matchCase" title="区分大小写" @click="emit('toggle-option', 'matchCase')">
      <CaseSensitive aria-hidden="true" />
    </button>

    <button type="button" class="search-panel-option-btn" :class="{ 'is-active': wholeWord }"
      :aria-pressed="wholeWord" title="全字匹配" @click="emit('toggle-option', 'wholeWord')">
      <WholeWord aria-hidden="true" />
    </button>

    <button type="button" class="search-panel-option-btn" :class="{ 'is-active': useRegex }" :aria-pressed="useRegex"
      title="正则表达式" @click="emit('toggle-option', 'useRegex')">
      <Regex aria-hidden="true" />
    </button>

    <button type="button" class="search-panel-option-btn" :class="{ 'is-active': contentFuzzy }"
      :aria-pressed="contentFuzzy" title="内容模糊匹配" @click="emit('toggle-option', 'contentFuzzy')">
      <Waves aria-hidden="true" />
    </button>

    <button type="button" class="search-panel-option-btn" :class="{ 'is-active': showPathFilters }"
      :aria-pressed="showPathFilters" title="包含 / 排除路径" @click="emit('toggle-option', 'showPathFilters')">
      <ListFilter aria-hidden="true" />
    </button>

    <button type="button" class="search-panel-option-btn search-panel-option-structural"
      :class="{ 'is-active': useStructural }" :aria-pressed="useStructural" title="结构化搜索与替换"
      @click="emit('toggle-structural')">
      <Braces aria-hidden="true" />
    </button>
  </div>
</template>

<script setup lang="ts">
import {
  Braces,
  CaseSensitive,
  Check,
  ListFilter,
  LoaderCircle,
  Regex,
  Replace,
  Search,
  Waves,
  WholeWord,
  X,
} from '@lucide/vue';
import { Input } from '@/components/ui/input';
import type { TWorkspaceSearchScope } from '@/types/search';
import type { TSearchToggleOption } from './search-sidebar.types';

interface IScopeChip {
  key: TWorkspaceSearchScope;
  label: string;
  count: number;
}

defineProps<{
  searchQuery: string;
  replacementQuery: string;
  useStructural: boolean;
  hasSearchQuery: boolean;
  canApplyReplacement: boolean;
  replaceRunning: boolean;
  scopeChips: IScopeChip[];
  activeScope: TWorkspaceSearchScope;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  contentFuzzy: boolean;
  showPathFilters: boolean;
}>();

const emit = defineEmits<{
  'update:searchQuery': [value: string];
  'update:replacementQuery': [value: string];
  'update:activeScope': [scope: TWorkspaceSearchScope];
  'replacement-action': [];
  'toggle-option': [option: TSearchToggleOption];
  'toggle-structural': [];
}>();
</script>
