import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';
const raw = readFileSync(FILE, 'utf8');
const usedCRLF = raw.includes('\r\n');
let src = usedCRLF ? raw.replace(/\r\n/g, '\n') : raw;

const edits = [
  // 移除两个动画方法
  {
    find:
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
      `const handleStop = (): void => {`,
    replace: `const handleStop = (): void => {`,
  },
  // 移除回形针按钮上的事件
  {
    find:
      `                    @click="handleOpenFileDialog"\n` +
      `                    @pointerdown="playIconBounce"\n` +
      `                    @animationend="endIconBounce"\n` +
      `                  >`,
    replace: `                    @click="handleOpenFileDialog"\n                  >`,
  },
  // 移除设置按钮上的事件
  {
    find:
      `                  aria-label="打开 AI 模式设置"\n` +
      `                  @pointerdown="playIconBounce"\n` +
      `                  @animationend="endIconBounce"\n` +
      `                >`,
    replace: `                  aria-label="打开 AI 模式设置"\n                >`,
  },
  // 移除弹跳 CSS（含 keyframes / reduced-motion）
  {
    find:
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
    replace: `}`,
  },
];

for (const [i, { find, replace }] of edits.entries()) {
  const count = src.split(find).length - 1;
  if (count !== 1) {
    console.error(`✗ 第 ${i + 1} 处匹配到 ${count} 次（应为 1），已中止。`);
    process.exit(1);
  }
  src = src.replace(find, replace);
}

writeFileSync(FILE, usedCRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('✓ 已移除点击弹跳，保留细线条');