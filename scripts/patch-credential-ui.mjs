import { readFileSync, writeFileSync } from 'node:fs';

const PROVIDER = 'src/components/business/ai/provider/AiProviderSettings.vue';
const PANEL = 'src/components/business/ai/shell/AiAssistantPanel.vue';

/** 精确单次替换；找不到锚点直接报错，已改过则跳过（幂等）。 */
function applyEdit(src, { find, replace, skipIf, label }) {
  if (skipIf && src.includes(skipIf)) {
    console.log(`⏭  跳过（已应用）：${label}`);
    return src;
  }
  const count = src.split(find).length - 1;
  if (count === 0) throw new Error(`❌ 未找到锚点：${label}（文件可能已变动）`);
  if (count > 1) throw new Error(`❌ 锚点不唯一（${count} 处）：${label}`);
  console.log(`✅ ${label}`);
  return src.replace(find, replace);
}

/** 读文件并归一化为 \n，同时记录原始 EOL，便于写回时还原。 */
function readNormalized(path) {
  const raw = readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { src: raw.replace(/\r\n/g, '\n'), eol };
}
function writeWithEol(path, src, eol) {
  writeFileSync(path, eol === '\r\n' ? src.replace(/\n/g, '\r\n') : src, 'utf8');
}

/* ───────────── AiProviderSettings.vue ───────────── */
let { src: provider, eol: providerEol } = readNormalized(PROVIDER);

// #1 行内操作按钮：补上 opacity:0 基线（仅 hover 设备隐藏，触摸设备保持常显）
provider = applyEdit(provider, {
  label: '#1 修复悬停显示（opacity 基线缺失）',
  skipIf: '.ai-credential-row__acts {\n    opacity: 0;',
  find: `@media (hover: hover) and (pointer: fine) {
  .ai-credential-row:hover {
    background: var(--ai-credential-surface-2);
  }

  .ai-credential-row:hover .ai-credential-row__acts,
  .ai-credential-row:focus-within .ai-credential-row__acts {
    opacity: 1;
  }
}`,
  replace: `@media (hover: hover) and (pointer: fine) {
  .ai-credential-row:hover {
    background: var(--ai-credential-surface-2);
  }

  .ai-credential-row__acts {
    opacity: 0;
    transition: opacity 150ms ease-out;
  }

  .ai-credential-row:hover .ai-credential-row__acts,
  .ai-credential-row:focus-within .ai-credential-row__acts {
    opacity: 1;
  }
}`,
});

// #3 名称（alias）输入时即时清除校验错误，与 API Key / Tavily Key 行为一致
provider = applyEdit(provider, {
  label: '#3 名称错误随输入清除',
  skipIf: 'watch(credentialAlias',
  find: `const tavilyKey = computed({
  get: () => props.tavilyApiKey,
  set: (value: string) => {
    tavilyKeyError.value = '';
    emit('update:tavilyApiKey', value);
  },
});`,
  replace: `const tavilyKey = computed({
  get: () => props.tavilyApiKey,
  set: (value: string) => {
    tavilyKeyError.value = '';
    emit('update:tavilyApiKey', value);
  },
});

// 名称输入时即时清除校验错误，和 API Key / Tavily Key 的清除行为保持一致。
watch(credentialAlias, () => {
  if (aliasError.value) {
    aliasError.value = '';
  }
});`,
});

// #13a 删除从未 emit 的 saveCredentials 事件声明
provider = applyEdit(provider, {
  label: '#13a 删除死事件声明 saveCredentials（子组件）',
  find: `  saveCredentials: [
    apiKey: string,
    providerId: TAiServicePlatformId,
    alias: string,
    feedback: IAiProviderSettingsActionFeedback,
  ];
`,
  replace: '',
});

writeWithEol(PROVIDER, provider, providerEol);

/* ───────────── AiAssistantPanel.vue（清理父层悬空接线）───────────── */
let { src: panel, eol: panelEol } = readNormalized(PANEL);

// #13b 移除模板里指向死事件的监听（否则子组件去掉 emit 后 Vue 会告警 extraneous listener）
panel = applyEdit(panel, {
  label: '#13b 移除 @save-credentials 监听（父模板）',
  find: `@save-credentials="saveCredentials" @test-provider="testProvider"`,
  replace: `@test-provider="testProvider"`,
});

// #13c 删除父层从未被触发的 saveCredentials 处理函数
panel = applyEdit(panel, {
  label: '#13c 删除死处理函数 saveCredentials（父组件）',
  find: `const saveCredentials = async (
  apiKey: string,
  providerId: string,
  alias: string,
  feedback: IAiProviderSettingsActionFeedback,
): Promise<void> => {
  try {
    await assistant.saveCredentials(apiKey, providerId, alias);
    settingsApiKey.value = '';
    settingsDraft.value = cloneAiConfigPayload(assistant.config.value);
    feedback.onSuccess('API Key 已保存到系统凭证');
  } catch (error) {
    feedback.onError(toErrorMessage(error, 'API Key 保存失败'));
  }
};

`,
  replace: '',
});

writeWithEol(PANEL, panel, panelEol);

console.log('\n🎉 全部完成。请运行 typecheck / lint 并自测。');