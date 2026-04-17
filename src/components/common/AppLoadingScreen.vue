<template>
  <div class="app-surface flex h-screen items-center justify-center p-6">
    <div class="linear-card w-full max-w-3xl px-8 py-10">
      <p class="text-xs uppercase tracking-[0.18em] text-[var(--text-quaternary)]">SH Editor</p>
      <h1 class="mt-3 text-3xl font-medium tracking-[-0.04em] text-[var(--text-primary)]">
        正在加载脚本工作台
      </h1>
      <p class="mt-3 text-sm leading-7 text-[var(--text-secondary)]">
        如果这里停留较久，说明工作台模块仍在初始化。若初始化失败，页面会直接显示错误详情，不会再出现白屏。
      </p>

      <div class="mt-8 space-y-3">
        <div class="h-3 w-40 animate-pulse rounded-full bg-white/[0.08]" />
        <div class="h-3 w-full animate-pulse rounded-full bg-white/[0.05]" />
        <div class="h-3 w-4/5 animate-pulse rounded-full bg-white/[0.05]" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts"></script>
