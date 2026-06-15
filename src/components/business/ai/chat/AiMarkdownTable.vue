<script setup lang="ts">
// markdown 节点样式仅 AI 面板需要：随本组件（懒加载）按需加载，不再进首屏 styles.css。
import 'markstream-vue/index.css';
import MarkdownRender from 'markstream-vue';
import { computed } from 'vue';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ITableCellNode {
  type: 'table_cell';
  header: boolean;
  children: Array<{
    type: string;
    raw: string;
    [key: string]: unknown;
  }>;
  raw: string;
  align?: 'left' | 'right' | 'center';
}

interface ITableRowNode {
  type: 'table_row';
  cells: ITableCellNode[];
  raw: string;
}

interface ITableNode {
  type: 'table';
  header: ITableRowNode;
  rows: ITableRowNode[];
  raw: string;
  loading?: boolean;
}

const props = withDefaults(
  defineProps<{
    node: ITableNode;
    indexKey: string | number;
    customId?: string;
    typewriter?: boolean;
  }>(),
  {
    customId: undefined,
    typewriter: false,
  },
);

const emit = defineEmits<{
  copy: [payload: unknown];
}>();

const rowList = computed(() => props.node.rows ?? []);

const resolveAlignClass = (align?: ITableCellNode['align']): string => {
  if (align === 'right') {
    return 'text-right';
  }

  if (align === 'center') {
    return 'text-center';
  }

  return 'text-left';
};
</script>

<template>
    <div class="ai-markdown-table" :aria-busy="props.node.loading === true">
        <Table class="ai-markdown-table__table">
            <TableHeader>
                <TableRow class="ai-markdown-table__row hover:bg-transparent data-[state=selected]:bg-transparent">
                    <TableHead
v-for="(cell, headerIndex) in props.node.header.cells"
                        :key="`header-${String(props.indexKey)}-${headerIndex}`" :class="[
                            'ai-markdown-table__head',
                            resolveAlignClass(cell.align),
                        ]">
                        <MarkdownRender
:nodes="cell.children" :custom-id="props.customId"
                            :index-key="`table-head-${String(props.indexKey)}-${headerIndex}`"
                            :typewriter="props.typewriter" :render-as-fragment="true" @copy="emit('copy', $event)" />
                    </TableHead>
                </TableRow>
            </TableHeader>

            <TableBody>
                <TableRow
v-for="(row, rowIndex) in rowList" :key="`row-${String(props.indexKey)}-${rowIndex}`"
                    class="ai-markdown-table__row hover:bg-transparent data-[state=selected]:bg-transparent">
                    <TableCell
v-for="(cell, cellIndex) in row.cells"
                        :key="`cell-${String(props.indexKey)}-${rowIndex}-${cellIndex}`" :class="[
                            'ai-markdown-table__cell',
                            resolveAlignClass(cell.align),
                        ]">
                        <MarkdownRender
:nodes="cell.children" :custom-id="props.customId"
                            :index-key="`table-cell-${String(props.indexKey)}-${rowIndex}-${cellIndex}`"
                            :typewriter="props.typewriter" :render-as-fragment="true" @copy="emit('copy', $event)" />
                    </TableCell>
                </TableRow>
            </TableBody>
        </Table>
    </div>
</template>

<style scoped>
.ai-markdown-table {
    width: fit-content;
    min-width: 50%;
    max-width: 100%;
    margin: 0 0 var(--ai-chat-space-paragraph, 12px);
    overflow-x: auto;
}

.ai-markdown-table__table {
    width: fit-content;
    min-width: 100%;
    border-collapse: collapse;
    border-spacing: 0;
}

.ai-markdown-table__row {
    border-bottom: 1px solid color-mix(in srgb, var(--shell-divider) 75%, transparent);
}

.ai-markdown-table__head,
.ai-markdown-table__cell {
    max-width: clamp(16ch, 48vw, 64ch);
    padding: 10px 14px;
    font-size: var(--ai-chat-font-size-table, 13px);
    line-height: var(--ai-chat-line-height-table, 20px);
    white-space: normal;
    overflow-wrap: anywhere;
}

.ai-markdown-table__head {
    color: var(--text-tertiary);
    font-weight: var(--ai-chat-font-weight-strong, 600);
    background: transparent;
}

.ai-markdown-table__cell {
    color: inherit;
    font-weight: 400;
}

.ai-markdown-table :deep(.markdown-renderer),
.ai-markdown-table :deep(.node-slot),
.ai-markdown-table :deep(.node-content),
.ai-markdown-table :deep(.node-space) {
    display: contents;
}

.ai-markdown-table :deep(pre) {
    max-width: 100%;
    overflow-x: auto;
    white-space: pre;
}

.ai-markdown-table :deep(pre code) {
    white-space: inherit;
    overflow-wrap: normal;
}
</style>
