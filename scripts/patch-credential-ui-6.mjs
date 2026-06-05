#!/usr/bin/env node
// patch-credential-ui-6.mjs
// 问题:高级里的 Base URL 输入框写死了 disabled(:model-value="selectedProvider.baseUrl" ... disabled),
//       用户完全无法点击/编辑,无法填写自定义 Base URL(代理 / 自建端点)。
// 修复:把 Base URL 改为可编辑(v-model=baseUrlInput),并在保存 / 测试 narrator 配置时
//       用用户填写的值覆盖默认路由;留空则回退厂商预设 baseUrl。
// 特性:幂等(已应用则跳过) + CRLF 安全(匹配前归一化为 \n,写回时还原行尾)。
// 仅改动 AiProviderSettings.vue。

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(
  __dirname,
  '../src/components/business/ai/provider/AiProviderSettings.vue',
);

const raw = readFileSync(TARGET, 'utf8');
const usesCRLF = raw.includes('\r\n');
let src = raw.replace(/\r\n/g, '\n');

let applied = 0;
let skipped = 0;

/**
 * @param label:string, find:string, replace:string, done:string edit
 *   done: 若该标记串已存在则视为已应用,跳过(保证幂等)。
 */
function applyEdit({ label, find, replace, done }) {
  if (done && src.includes(done)) {
    console.log(`\u2022 \u8df3\u8fc7(\u5df2\u5e94\u7528):${label}`);
    skipped += 1;
    return;
  }
  const idx = src.indexOf(find);
  if (idx === -1) {
    throw new Error(`\u274c \u672a\u627e\u5230\u951a\u70b9:${label}`);
  }
  if (src.indexOf(find, idx + 1) !== -1) {
    throw new Error(`\u274c \u951a\u70b9\u4e0d\u552f\u4e00:${label}`);
  }
  src = src.slice(0, idx) + replace + src.slice(idx + find.length);
  console.log(`\u2713 \u5df2\u5e94\u7528:${label}`);
  applied += 1;
}

// 1) 新增 baseUrlInput ref
applyEdit({
  label: '#BaseURL-1 \u65b0\u589e baseUrlInput ref',
  find: `const isTavilyKeyVisible = ref(false);\n`,
  replace: `const isTavilyKeyVisible = ref(false);\nconst baseUrlInput = ref('');\n`,
  done: `const baseUrlInput = ref('');`,
});

// 2) openForm:打开表单时用当前厂商预设填充 baseUrlInput
applyEdit({
  label: '#BaseURL-2 openForm \u521d\u59cb\u5316 baseUrlInput',
  find: `  isSmallModelMenuOpen.value = false;\n  pane.value = 'form';`,
  replace: `  isSmallModelMenuOpen.value = false;\n  baseUrlInput.value = selectedProvider.value.baseUrl ?? '';\n  pane.value = 'form';`,
  done: `baseUrlInput.value = selectedProvider.value.baseUrl ?? '';\n  pane.value = 'form';`,
});

// 3) handleProviderChange:切换厂商时同步 baseUrlInput
applyEdit({
  label: '#BaseURL-3 handleProviderChange \u540c\u6b65 baseUrlInput',
  find: `  selectedProviderId.value = providerId as TAiServicePlatformId;\n`,
  replace: `  selectedProviderId.value = providerId as TAiServicePlatformId;\n  baseUrlInput.value = selectedProvider.value.baseUrl ?? '';\n`,
  done: `selectedProviderId.value = providerId as TAiServicePlatformId;\n  baseUrlInput.value = selectedProvider.value.baseUrl ?? '';`,
});

// 4) open 重置 watch:重置 baseUrlInput
applyEdit({
  label: '#BaseURL-4 open \u91cd\u7f6e baseUrlInput',
  find: `    selectedProviderId.value = mainProviderId.value;\n`,
  replace: `    selectedProviderId.value = mainProviderId.value;\n    baseUrlInput.value = selectedProvider.value.baseUrl ?? '';\n`,
  done: `    selectedProviderId.value = mainProviderId.value;\n    baseUrlInput.value = selectedProvider.value.baseUrl ?? '';`,
});

// 5) saveProviderSettings:用 baseUrlInput 覆盖 narrator.baseUrl(留空回退预设)
applyEdit({
  label: '#BaseURL-5 saveProviderSettings \u5199\u5165\u81ea\u5b9a\u4e49 baseUrl',
  find: `  emit(\n    'save',\n    createRoleConfig(selectedProvider.value, 'narrator', selectedSmallModel.value.id),\n    normalizedApiKey,`,
  replace: `  const narratorConfig = createRoleConfig(selectedProvider.value, 'narrator', selectedSmallModel.value.id);\n  narratorConfig.narrator.baseUrl = baseUrlInput.value.trim() || selectedProvider.value.baseUrl || null;\n  emit(\n    'save',\n    narratorConfig,\n    normalizedApiKey,`,
  done: `narratorConfig.narrator.baseUrl = baseUrlInput.value.trim()`,
});

// 6) testSelectedProvider:测试时也带上自定义 baseUrl
applyEdit({
  label: '#BaseURL-6 testSelectedProvider \u5199\u5165\u81ea\u5b9a\u4e49 baseUrl',
  find: `  const draft = createRoleConfig(selectedProvider.value, role, selectedSmallModel.value.id);\n`,
  replace: `  const draft = createRoleConfig(selectedProvider.value, role, selectedSmallModel.value.id);\n  draft.narrator.baseUrl = baseUrlInput.value.trim() || selectedProvider.value.baseUrl || null;\n`,
  done: `draft.narrator.baseUrl = baseUrlInput.value.trim()`,
});

// 7) 模板:Base URL 输入框改 v-model(同时去掉 :model-value)
applyEdit({
  label: '#BaseURL-7 \u6a21\u677f\u6539 v-model',
  find: `<Input id="ai-base-url" class="ai-credential-input" :model-value="selectedProvider.baseUrl"`,
  replace: `<Input id="ai-base-url" v-model="baseUrlInput" class="ai-credential-input"`,
  done: `<Input id="ai-base-url" v-model="baseUrlInput" class="ai-credential-input"`,
});

// 8) 模板:移除 disabled,补 autocomplete/spellcheck
applyEdit({
  label: '#BaseURL-8 \u6a21\u677f\u79fb\u9664 disabled',
  find: ` disabled />`,
  replace: ` autocomplete="off" spellcheck="false" />`,
  done: `placeholder="\u4f7f\u7528\u7cfb\u7edf\u9ed8\u8ba4\u8def\u7531" autocomplete="off" spellcheck="false" />`,
});

// 9) 提示文案:\u201c\u7531\u6a21\u578b\u8def\u7531\u7ba1\u7406\u201d -> \u201c\u7559\u7a7a\u7528\u9ed8\u8ba4\u8def\u7531\u201d
applyEdit({
  label: '#BaseURL-9 \u66f4\u65b0\u63d0\u793a\u6587\u6848',
  find: `<span>\u7531\u6a21\u578b\u8def\u7531\u7ba1\u7406</span>`,
  replace: `<span>\u7559\u7a7a\u7528\u9ed8\u8ba4\u8def\u7531</span>`,
  done: `<span>\u7559\u7a7a\u7528\u9ed8\u8ba4\u8def\u7531</span>`,
});

const out = usesCRLF ? src.replace(/\n/g, '\r\n') : src;
writeFileSync(TARGET, out, 'utf8');
console.log(`\n\u5b8c\u6210:\u5e94\u7528 ${applied} \u5904,\u8df3\u8fc7 ${skipped} \u5904 -> ${TARGET}`);
