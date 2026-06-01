<template>
  <div class="explorer-node" :class="{ 'is-open': shouldShowChildren }">
    <button v-if="!isRenamingEntry" type="button" class="explorer-tree-row w-full text-left"
      :class="{ 'is-active': isActive, 'is-context-target': isContextTarget }" :style="rowStyle"
      role="treeitem" :aria-level="level + 1" :aria-selected="isActive"
      :aria-expanded="isDirectory ? shouldShowChildren : undefined" @click="handleClick"
      @contextmenu.prevent.stop="handleContextMenu">
      <span class="explorer-chevron" :class="{ 'is-placeholder': !showChevron }">
        <svg v-if="showChevron" viewBox="0 0 12 12" class="h-3 w-3 transition-transform"
          :class="shouldShowChildren ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>

      <ExplorerEntryIcon :kind="entry.kind" :path="entry.path" :expanded="shouldShowChildren"
        class="h-4 w-4 shrink-0" />

      <span class="explorer-tree-name" v-text="entry.name"></span>
      <span v-if="showDirtyMarker" class="explorer-tree-meta">M</span>
    </button>

    <div v-else class="explorer-tree-row w-full text-left"
      :class="{ 'is-active': isActive, 'is-context-target': isContextTarget }" :style="rowStyle"
      role="treeitem" :aria-level="level + 1" :aria-selected="isActive"
      @contextmenu.prevent.stop="handleContextMenu">
      <span class="explorer-chevron" :class="{ 'is-placeholder': !showChevron }">
        <svg v-if="showChevron" viewBox="0 0 12 12" class="h-3 w-3 transition-transform"
          :class="shouldShowChildren ? 'rotate-90' : ''" fill="none" stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 2.5 8 6 4 9.5" />
        </svg>
      </span>

      <ExplorerEntryIcon :kind="entry.kind" :path="entry.path" :expanded="shouldShowChildren"
        class="h-4 w-4 shrink-0" />

      <input class="explorer-inline-create-input explorer-inline-rename-input" type="text" aria-label="重命名文件"
        :value="inlineRenameDraft?.value ?? entry.name" @input="handleInlineRenameInput"
        @blur="$emit('inline-rename-confirm')" @pointerdown.stop @click.stop
        @keydown.enter.prevent.stop="$emit('inline-rename-confirm')"
        @keydown.esc.prevent.stop="$emit('inline-rename-cancel')" />
      <span v-if="showDirtyMarker" class="explorer-tree-meta">M</span>
    </div>

    <div v-if="shouldShowChildren" class="explorer-tree-children" role="group">
      <div v-if="isLoading" class="explorer-helper-text explorer-helper-text-padded" :style="childStateStyle">
        正在读取目录...
      </div>
      <div v-else-if="visibleChildEntries.length === 0 && !hasActiveSearch"
        class="explorer-helper-text explorer-helper-text-padded" :style="childStateStyle">
        空文件夹
      </div>

      <WorkspaceTreeNode v-for="child in visibleChildEntries" :key="child.path" :entry="child" :level="level + 1"
        :children-map="childrenMap" :expanded-paths="expandedPaths" :loading-paths="loadingPaths"
        :active-path="activePath" :active-dirty="activeDirty" :context-menu-path="contextMenuPath"
        :search-query="searchQuery" :inline-create-draft="inlineCreateDraft" :root-path="rootPath"
        :inline-rename-draft="inlineRenameDraft" @toggle-directory="$emit('toggle-directory', $event)"
        @open-file="$emit('open-file', $event)" @context-menu="$emit('context-menu', $event)"
        @inline-create-input="$emit('inline-create-input', $event)" @inline-create-blur="$emit('inline-create-blur')"
        @inline-create-confirm="$emit('inline-create-confirm')" @inline-create-cancel="$emit('inline-create-cancel')"
        @inline-rename-input="$emit('inline-rename-input', $event)"
        @inline-rename-confirm="$emit('inline-rename-confirm')" @inline-rename-cancel="$emit('inline-rename-cancel')" />

      <div v-if="showInlineCreateDraft" class="explorer-tree-row explorer-tree-inline-create"
        :style="inlineCreateRowStyle">
        <span class="explorer-chevron is-placeholder"></span>

        <ExplorerEntryIcon :kind="inlineCreateDraft?.kind === 'directory' ? 'directory' : 'file'" :path="entry.path"
          class="h-4 w-4 shrink-0" />

        <input class="explorer-inline-create-input" :value="inlineCreateD