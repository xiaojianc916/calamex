import { readFileSync, writeFileSync } from 'node:fs';

const PROVIDER = 'src/components/business/ai/provider/AiProviderSettings.vue';

function applyEdit(src, { find, replace, skip, label }) {
  if (skip && skip(src)) {
    console.log(`⏭  跳过(已应用):${label}`);
    return src;
  }
  const count = src.split(find).length - 1;
  if (count === 0) throw new Error(`❌ 未找到锚点:${label}(请确认本地已 git pull 最新 main)`);
  if (count > 1) throw new Error(`❌ 锚点不唯一(${count} 处):${label}`);
  console.log(`✅ ${label}`);
  return src.replace(find, replace);
}

function readNormalized(path) {
  const raw = readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { src: raw.replace(/\r\n/g, '\n'), eol };
}
function writeWithEol(path, src, eol) {
  writeFileSync(path, eol === '\r\n' ? src.replace(/\n/g, '\r\n') : src, 'utf8');
}

let { src, eol } = readNormalized(PROVIDER);

/* ── 1) 新增 Tavily Key 显隐状态(紧跟 isKeyVisible) ── */
src = applyEdit(src, {
  label: '#10 新增 isTavilyKeyVisible ref',
  skip: (s) => s.includes('isTavilyKeyVisible = ref(false)'),
  find: `const isKeyVisible = ref(false);`,
  replace: `const isKeyVisible = ref(false);\nconst isTavilyKeyVisible = ref(false);`,
});

/* ── 2) openForm:打开表单时复位显隐(与 isKeyVisible 行为一致,安全起见默认隐藏) ── */
src = applyEdit(src, {
  label: '#10 openForm 复位 isTavilyKeyVisible',
  skip: (s) => s.includes('  isTavilyKeyVisible.value = false;\n  isProviderMenuOpen'),
  find: `  isKeyVisible.value = false;
  isProviderMenuOpen.value = false;
  isSmallModelMenuOpen.value = false;
  pane.value = 'form';`,
  replace: `  isKeyVisible.value = false;
  isTavilyKeyVisible.value = false;
  isProviderMenuOpen.value = false;
  isSmallModelMenuOpen.value = false;
  pane.value = 'form';`,
});

/* ── 3) watch(open):每次打开弹窗复位显隐 ── */
src = applyEdit(src, {
  label: '#10 watch(open) 复位 isTavilyKeyVisible',
  skip: (s) => s.includes('    isTavilyKeyVisible.value = false;\n    isProviderMenuOpen'),
  find: `    isKeyVisible.value = false;
    isProviderMenuOpen.value = false;
    isSmallModelMenuOpen.value = false;
  },
);`,
  replace: `    isKeyVisible.value = false;
    isTavilyKeyVisible.value = false;
    isProviderMenuOpen.value = false;
    isSmallModelMenuOpen.value = false;
  },
);`,
});

/* ── 4) Tavily 输入框 type 改为动态(镜像厂商 Key) ── */
src = applyEdit(src, {
  label: '#10 Tavily 输入框 type 动态化',
  skip: (s) => s.includes("isTavilyKeyVisible ? 'text'"),
  find: `                    data-tavily-input type="password" autocomplete="off" spellcheck="false" placeholder="Tavily API Key"`,
  replace: `                    data-tavily-input :type="isTavilyKeyVisible ? 'text' : 'password'" autocomplete="off" spellcheck="false" placeholder="Tavily API Key"`,
});

/* ── 5) 在「保存」按钮左侧插入 eye 显隐按钮(复用 .ai-credential-key-toggle) ── */
src = applyEdit(src, {
  label: '#10 插入 Tavily eye 切换按钮',
  skip: (s) => s.includes('ai-credential-key-toggle--tavily'),
  find: `                    :aria-invalid="tavilyKeyError ? 'true' : 'false'" />
                  <Button class="ai-credential-inline-save"`,
  replace: `                    :aria-invalid="tavilyKeyError ? 'true' : 'false'" />
                  <Button class="ai-credential-key-toggle ai-credential-key-toggle--tavily" variant="ghost"
                    size="icon-sm" type="button"
                    :aria-label="isTavilyKeyVisible ? '隐藏 Tavily API Key' : '显示 Tavily API Key'"
                    @click="isTavilyKeyVisible = !isTavilyKeyVisible">
                    <span v-if="isTavilyKeyVisible" aria-hidden="true" class="icon-[lucide--eye-off]" />
                    <span v-else aria-hidden="true" class="icon-[lucide--eye]" />
                  </Button>
                  <Button class="ai-credential-inline-save"`,
});

/* ── 6) CSS:eye 切换左移到「保存」左侧(right: 48px) ── */
src = applyEdit(src, {
  label: '#10 新增 .ai-credential-key-toggle--tavily 定位',
  skip: (s) => s.includes('.ai-credential-key-toggle--tavily {'),
  find: `.ai-credential-key-toggle svg {
  width: 14px;
  height: 14px;
}`,
  replace: `.ai-credential-key-toggle svg {
  width: 14px;
  height: 14px;
}

.ai-credential-key-toggle--tavily {
  right: 48px;
}`,
});

writeWithEol(PROVIDER, src, eol);
console.log('\n🎉 #10 完成。请运行 typecheck / lint 并自测。');
