<template>
  <aside class="flex h-full flex-col gap-4 overflow-hidden px-5 py-5">
    <section class="linear-card-soft space-y-4 p-4">
      <div>
        <p class="text-xs uppercase tracking-[0.18em] text-[var(--text-quaternary)]">基础辅助</p>
        <h3 class="mt-2 text-lg font-medium text-[var(--text-primary)]">编辑设置</h3>
      </div>
      <div class="space-y-3">
        <div>
          <p class="mb-2 text-xs text-[var(--text-tertiary)]">字符编码</p>
          <Select
            class="w-full"
            :model-value="encoding"
            @update:model-value="$emit('change-encoding', $event)"
          >
            <SelectItem
              v-for="item in encodingOptions"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </SelectItem>
          </Select>
        </div>
        <div>
          <p class="mb-2 text-xs text-[var(--text-tertiary)]">执行环境</p>
          <Select
            class="w-full"
            :model-value="executor"
            @update:model-value="$emit('change-executor', $event)"
          >
            <SelectItem
              v-for="item in executorOptions"
              :key="item.value"
              :value="item.value"
            >
              {{ item.label }}
            </SelectItem>
          </Select>
        </div>
        <button
          class="linear-button flex w-full items-center justify-between px-4 py-3 text-sm"
          @click="$emit('toggle-theme')"
        >
          <span>{{ theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题' }}</span>
          <span class="text-[var(--text-quaternary)]">{{ theme === 'dark' ? 'Dark' : 'Light' }}</span>
        </button>
      </div>
    </section>

    <section class="linear-card-soft space-y-4 p-4">
      <div>
        <p class="text-xs uppercase tracking-[0.18em] text-[var(--text-quaternary)]">执行器探测</p>
        <h3 class="mt-2 text-lg font-medium text-[var(--text-primary)]">运行环境</h3>
      </div>
      <div
        v-if="environment.executors.length > 0"
        class="space-y-2"
      >
        <div
          v-for="item in environment.executors"
          :key="item.type"
          class="rounded-2xl border px-3 py-3"
          :class="
            item.available
              ? 'border-white/[0.08] bg-white/[0.04]'
              : 'border-white/5 bg-white/[0.02] opacity-70'
          "
        >
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium text-[var(--text-primary)]">{{ item.label }}</p>
              <p class="mt-1 text-xs text-[var(--text-quaternary)]">{{ item.description }}</p>
            </div>
            <span
              class="h-2.5 w-2.5 rounded-full"
              :class="item.available ? 'bg-emerald-400' : 'bg-white/[0.15]'"
            />
          </div>
          <p class="mono-text mt-2 truncate text-[11px] text-[var(--text-quaternary)]">
            {{ item.commandPath ?? '未找到对应可执行文件' }}
          </p>
        </div>
      </div>
      <div
        v-else
        class="rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.03] px-4 py-4 text-sm leading-6 text-[var(--text-tertiary)]"
      >
        {{
          isDesktopRuntime
            ? '暂未检测到可用的 shell 运行环境，建议优先安装或启用 WSL2，Git Bash 可作为备用方案。'
            : '当前为浏览器预览模式，执行器探测与脚本运行仅支持 Tauri 桌面端。'
        }}
      </div>
    </section>

    <section class="linear-card-soft min-h-0 flex-1 space-y-4 p-4">
      <div>
        <p class="text-xs uppercase tracking-[0.18em] text-[var(--text-quaternary)]">快捷工具</p>
        <h3 class="mt-2 text-lg font-medium text-[var(--text-primary)]">命令模板</h3>
      </div>
      <div class="space-y-2 overflow-auto pr-1">
        <button
          v-for="item in commandTemplates"
          :key="item.id"
          class="w-full rounded-2xl border border-white/[0.06] bg-white/[0.04] px-3 py-3 text-left transition hover:border-white/10 hover:bg-white/[0.06]"
          @click="$emit('insert-template', item)"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="text-sm font-medium text-[var(--text-primary)]">{{ item.title }}</p>
            <span class="linear-pill px-2 py-1 text-[10px]">{{ item.category }}</span>
          </div>
          <p class="mt-2 text-xs leading-5 text-[var(--text-tertiary)]">{{ item.description }}</p>
        </button>
      </div>
    </section>

    <section class="linear-card-soft space-y-3 p-4">
      <div>
        <p class="text-xs uppercase tracking-[0.18em] text-[var(--text-quaternary)]">备注模板</p>
      </div>
      <div class="grid grid-cols-1 gap-2">
        <button
          v-for="item in commentTemplates"
          :key="item.id"
          class="linear-button px-3 py-2 text-left text-sm"
          @click="$emit('insert-comment', item)"
        >
          {{ item.title }}
        </button>
      </div>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { Select, SelectItem } from '@/components/ui';
import type { TThemeMode } from '@/types/app';
import type {
    ICommandTemplate,
    IExecutionEnvironment,
    TDocumentEncoding,
    TExecutorKind,
} from '@/types/editor';
import { ENCODING_OPTIONS, EXECUTOR_OPTIONS } from '@/utils/templates';

defineProps<{
  encoding: TDocumentEncoding;
  executor: TExecutorKind;
  environment: IExecutionEnvironment;
  theme: TThemeMode;
  isDesktopRuntime: boolean;
  commandTemplates: ICommandTemplate[];
  commentTemplates: ICommandTemplate[];
}>();

defineEmits<{
  'change-encoding': [value: TDocumentEncoding];
  'change-executor': [value: TExecutorKind];
  'toggle-theme': [];
  'insert-template': [value: ICommandTemplate];
  'insert-comment': [value: ICommandTemplate];
}>();

const encodingOptions = ENCODING_OPTIONS;
const executorOptions = EXECUTOR_OPTIONS;
</script>
