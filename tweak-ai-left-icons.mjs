import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';

const raw = readFileSync(FILE, 'utf8');
const usedCRLF = raw.includes('\r\n');
let src = usedCRLF ? raw.replace(/\r\n/g, '\n') : raw;

const edits = [
  // A. 引入 lucide 组件
  {
    find: `import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';`,
    replace:
      `import { Paperclip, Settings2 } from 'lucide-vue-next';\n` +
      `import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';`,
  },

  // B. 弹跳动画的两个方法（插在 handleStop 之前）
  {
    find: `const handleStop = (): void => {\n  emit('stop');\n};`,
    replace:
      `const playIconBounce = (event: PointerEvent): void => {\n` +
      `  const trigger = event.currentTarget;\n` +
      `  if (!(trigger instanceof HTMLElement)) {\n` +
      `    return;\n` +
      `  }\n` +
      `  const glyph = trigger.querySelector('svg');\n` +
      `  if (!glyph) {\n` +
      `    return;\n` +
      `  }\n` +
      `  glyph.classList.remove('is-icon-bouncing');\n` +
      `  // 强制回流，确保连续点击都能重新触发动画\n` +
      `  void glyph.getBoundingClientRect();\n` +
      `  glyph.classList.add('is-icon-bouncing');\n` +
      `};\n\n` +
      `const endIconBounce = (event: AnimationEvent): void => {\n` +
      `  const glyph = event.target;\n` +
      `  if (glyph instanceof Element) {\n` +
      `    glyph.classList.remove('is-icon-bouncing');\n` +
      `  }\n` +
      `};\n\n` +
      `const handleStop = (): void => {\n  emit('stop');\n};`,
  },

  // C. 回形针按钮：换成 Paperclip 组件 + 绑定动画事件
  {
    find:
      `                  <InputGroupButton\n` +
      `                    type="button"\n` +
      `                    variant="ghost"\n` +
      `                    class="ai-icon-action ai-attachment-button"\n` +
      `                    size="icon-xs"\n` +
      `                    :disabled="disabled"\n` +
      `                    aria-label="提供背景信息"\n` +
      `                    @click="handleOpenFileDialog"\n` +
      `                  >\n` +
      `                    <span class="icon-[lucide--paperclip] size-4" />\n` +
      `                  </InputGroupButton>`,
    replace:
      `                  <InputGroupButton\n` +
      `                    type="button"\n` +
      `                    variant="ghost"\n` +
      `                    class="ai-icon-action ai-attachment-button"\n` +
      `                    size="icon-xs"\n` +
      `                    :disabled="disabled"\n` +
      `                    aria-label="提供背景信息"\n` +
      `                    @click="handleOpenFileDialog"\n` +
      `                    @pointerdown="playIconBounce"\n` +
      `                    @animationend="endIconBounce"\n` +
      `                  >\n` +
      `                    <Paperclip class="size-4" :stroke-width="1.5" />\n` +
      `                  </InputGroupButton>`,
  },

  // D. 设置按钮：换成 Settings2 组件 + 绑定动画事件
  {
    find:
      `                <InputGroupButton\n` +
      `                  type="button"\n` +
      `                  variant="ghost"\n` +
      `                  class="ai-icon-action ai-mode-trigger"\n` +
      `                  size="icon-xs"\n` +
      `                  :disabled="disabled"\n` +
      `                  aria-label="打开 AI 模式设置"\n` +
      `                >\n` +
      `                  <span class="icon-[lucide--settings-2] size-4" />\n` +
      `                </InputGroupButton>`,
    replace:
      `                <InputGroupButton\n` +
      `                  type="button"\n` +
      `                  variant="ghost"\n` +
      `                  class="ai-icon-action ai-mode-trigger"\n` +
      `                  size="icon-xs"\n` +
      `                  :disabled="disabled"\n` +
      `                  aria-label="打开 AI 模式设置"\n` +
      `                  @pointerdown="playIconBounce"\n` +
      `                  @animationend="endIconBounce"\n` +
      `                >\n` +
      `                  <Settings2 class="size-4" :stroke-width="1.5" />\n` +
      `                </InputGroupButton>`,
  },

  // E. 弹跳动画 CSS（插在图标尺寸规则之后）
  {
    find:
      `.ai-icon-action :deep(svg),\n` +
      `.ai-send-button :deep(svg),\n` +
      `.ai-token-trigger :deep(img) {\n` +
      `  width: var(--ai-composer-icon-size);\n` +
      `  height: var(--ai-composer-icon-size);\n` +
      `}`,
    replace:
      `.ai-icon-action :deep(svg),\n` +
      `.ai-send-button :deep(svg),\n` +
      `.ai-token-trigger :deep(img) {\n` +
      `  width: var(--ai-composer-icon-size);\n` +
      `  height: var(--ai-composer-icon-size);\n` +
      `}\n\n` +
      `.ai-icon-action :deep(svg.is-icon-bouncing) {\n` +
      `  transform-origin: center;\n` +
      `  animation: ai-icon-bounce 460ms cubic-bezier(0.22, 1, 0.36, 1);\n` +
      `}\n\n` +
      `@media (prefers-reduced-motion: reduce) {\n` +
      `  .ai-icon-action :deep(svg.is-icon-bouncing) {\n` +
      `    animation: none;\n` +
      `  }\n` +
      `}\n\n` +
      `@keyframes ai-icon-bounce {\n` +
      `  0% {\n    transform: scale(1);\n  }\n` +
      `  25% {\n    transform: scale(0.82);\n  }\n` +
      `  50% {\n    transform: scale(1.16);\n  }\n` +
      `  70% {\n    transform: scale(0.94);\n  }\n` +
      `  85% {\n    transform: scale(1.05);\n  }\n` +
      `  100% {\n    transform: scale(1);\n  }\n` +
      `}`,
  },
];

for (const [i, { find, replace }] of edits.entries()) {
  const count = src.split(find).length - 1;
  if (count !== 1) {
    console.error(`✗ 第 ${i + 1} 处改动匹配到 ${count} 次（应为 1），已中止，未写入。`);
    process.exit(1);
  }
  src = src.replace(find, replace);
}

writeFileSync(FILE, usedCRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('✓ 已更新 AiPromptInput.vue：左下两图标线条调细 + 点击弹跳');