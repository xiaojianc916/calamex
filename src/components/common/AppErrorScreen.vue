<template>
  <div class="app-surface flex h-screen items-center justify-center p-6">
    <div class="linear-card w-full max-w-5xl overflow-hidden">
      <div class="border-b border-white/[0.06] px-6 py-5">
        <p class="text-xs uppercase tracking-[0.16em] text-rose-300">Runtime Diagnostics</p>
        <h2 class="mt-2 text-2xl font-medium text-[var(--text-primary)]">
          {{ errorState?.title ?? '工作台加载失败' }}
        </h2>
        <p class="mt-2 text-sm text-[var(--text-secondary)]">
          已捕获到前端运行错误，请把下面的错误信息发给我，我可以继续直接修复。
        </p>
      </div>
      <div class="space-y-4 px-6 py-5">
        <div class="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
          <p class="text-sm font-medium text-[var(--text-primary)]">错误摘要</p>
          <p class="mt-2 text-sm leading-6 text-rose-200">
            {{ errorState?.message ?? '未获取到错误摘要' }}
          </p>
        </div>
        <div class="rounded-2xl border border-white/[0.08] bg-[#0b0c0e] px-4 py-4">
          <p class="mb-3 text-sm font-medium text-[var(--text-primary)]">详细堆栈</p>
          <pre class="mono-text max-h-[420px] overflow-auto whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--text-secondary)]">{{ errorState?.detail ?? '无详细堆栈信息' }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { runtimeErrorState } from '@/utils/runtime-diagnostics';

const errorState = computed(() => runtimeErrorState.value);
</script>
