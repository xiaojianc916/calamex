import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';
const raw = readFileSync(FILE, 'utf8');
const usedCRLF = raw.includes('\r\n');
let src = usedCRLF ? raw.replace(/\r\n/g, '\n') : raw;

const edits = [
  {
    find: `import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';`,
    replace:
      `import { Paperclip, Settings2 } from 'lucide-vue-next';\n` +
      `import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';`,
  },
  {
    find:
      `                    @click="handleOpenFileDialog"\n` +
      `                  >\n` +
      `                    <span class="icon-[lucide--paperclip] size-4" />\n` +
      `                  </InputGroupButton>`,
    replace:
      `                    @click="handleOpenFileDialog"\n` +
      `                  >\n` +
      `                    <Paperclip class="size-4" :stroke-width="1.5" />\n` +
      `                  </InputGroupButton>`,
  },
  {
    find:
      `                  aria-label="打开 AI 模式设置"\n` +
      `                >\n` +
      `                  <span class="icon-[lucide--settings-2] size-4" />\n` +
      `                </InputGroupButton>`,
    replace:
      `                  aria-label="打开 AI 模式设置"\n` +
      `                >\n` +
      `                  <Settings2 class="size-4" :stroke-width="1.5" />\n` +
      `                </InputGroupButton>`,
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
console.log('✓ 左下两图标已调细，无弹跳');