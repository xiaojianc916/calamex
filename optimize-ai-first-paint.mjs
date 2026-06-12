#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const changedFiles = [];

const filePath = (relativePath) => path.join(root, relativePath);

const readText = (relativePath) => fs.readFileSync(filePath(relativePath), 'utf8');

const writeText = (relativePath, content, original) => {
  if (content === original) return;
  fs.writeFileSync(filePath(relativePath), content, 'utf8');
  changedFiles.push(relativePath);
};

const ensureRepoFile = (relativePath) => {
  if (!fs.existsSync(filePath(relativePath))) {
    throw new Error(`缺少文件：${relativePath}\n请在 calamex 仓库根目录运行这个脚本。`);
  }
};

const replaceAll = (content, oldText, newText) => content.split(oldText).join(newText);

const replaceOne = (content, oldText, newText, label) => {
  if (!content.includes(oldText)) {
    throw new Error(`未找到预期片段：${label}`);
  }
  return content.replace(oldText, newText);
};

const insertBefore = (content, marker, insertion, label) => {
  if (content.includes(insertion.trim())) return content;
  if (!content.includes(marker)) {
    throw new Error(`未找到插入锚点：${label}`);
  }
  return content.replace(marker, `${insertion}${marker}`);
};

const updatePromptInput = () => {
  const relativePath = 'src/components/business/ai/chat/AiPromptInput.vue';
  ensureRepoFile(relativePath);

  const original = readText(relativePath);
  let content = original;

  // 加一个去重的技能加载 promise，避免 / 菜单触发时重复拉取。
  if (!content.includes('let skillsLoadPromise: Promise<void> | null = null;')) {
    content = replaceOne(
      content,
      `const skillsManagerOpen = ref(false);

const MODE_SUBMENU_CLOSE_DELAY_MS = 180;`,
      `const skillsManagerOpen = ref(false);
let skillsLoadPromise: Promise<void> | null = null;

const MODE_SUBMENU_CLOSE_DELAY_MS = 180;`,
      'AiPromptInput skillsLoadPromise',
    );
  }

  // 增加按需加载函数。
  content = insertBefore(
    content,
    `const updateSlashStateFromCaret = (): void => {`,
    `const ensureSkillsLoaded = (): Promise<void> => {
  if (skills.value.length > 0) {
    return Promise.resolve();
  }

  skillsLoadPromise ??= loadSkills().finally(() => {
    skillsLoadPromise = null;
  });
  return skillsLoadPromise;
};

`,
    'AiPromptInput ensureSkillsLoaded',
  );

  // / 菜单打开时才加载 skills。
  content = replaceAll(
    content,
    `      void loadSkills();
    }
    refreshSlashAnchorRect();`,
    `      void ensureSkillsLoaded();
    }
    refreshSlashAnchorRect();`,
  );

  // 打开 skill 管理器时才加载 skills。
  content = replaceAll(
    content,
    `  void loadSkills();
  skillsManagerOpen.value = true;`,
    `  void ensureSkillsLoaded();
  skillsManagerOpen.value = true;`,
  );

  // 删除挂载时 loadSkills，保留编辑器初始化。
  content = replaceAll(
    content,
    `onMounted(() => {
  void loadSkills();
  applyValueToEditor(modelValue.value ?? '', selectedSkills.value ?? []);
});`,
    `onMounted(() => {
  applyValueToEditor(modelValue.value ?? '', selectedSkills.value ?? []);
});`,
  );

  writeText(relativePath, content, original);
};

const updateWorkspaceSurface = () => {
  const relativePath = 'src/components/business/ai/shell/AiWorkspaceSurface.vue';
  ensureRepoFile(relativePath);

  const original = readText(relativePath);
  let content = original;

  // 引入 defineAsyncComponent。
  content = replaceAll(
    content,
    `import { computed, onBeforeUnmount, ref } from 'vue';`,
    `import { computed, defineAsyncComponent, onBeforeUnmount, ref } from 'vue';`,
  );

  // 如果已经有 defineAsyncComponent，不重复处理 import。
  content = replaceAll(
    content,
    `import { computed, defineAsyncComponent, defineAsyncComponent, onBeforeUnmount, ref } from 'vue';`,
    `import { computed, defineAsyncComponent, onBeforeUnmount, ref } from 'vue';`,
  );

  // 去掉右侧预览静态导入。
  content = replaceAll(
    content,
    `import AiWebPreviewSidebar from '@/components/business/ai/shell/AiWebPreviewSidebar.vue';
`,
    '',
  );

  // 加异步组件定义。
  content = insertBefore(
    content,
    `defineProps<{`,
    `const DeferredAiWebPreviewSidebar = defineAsyncComponent({
  loader: () => import('@/components/business/ai/shell/AiWebPreviewSidebar.vue'),
  suspensible: false,
});

`,
    'AiWorkspaceSurface DeferredAiWebPreviewSidebar',
  );

  // 模板改为按需组件。
  content = replaceAll(
    content,
    `<AiWebPreviewSidebar class="min-h-0 flex-1" @close-sidebar="toggleRightSidebar" />`,
    `<DeferredAiWebPreviewSidebar class="min-h-0 flex-1" @close-sidebar="toggleRightSidebar" />`,
  );

  writeText(relativePath, content, original);
};

const updateAssistantPanel = () => {
  const relativePath = 'src/components/business/ai/shell/AiAssistantPanel.vue';
  ensureRepoFile(relativePath);

  const original = readText(relativePath);
  let content = original;

  // 引入 defineAsyncComponent。
  content = replaceAll(
    content,
    `import { computed, onMounted, ref } from 'vue';`,
    `import { computed, defineAsyncComponent, onMounted, ref } from 'vue';`,
  );

  content = replaceAll(
    content,
    `import { computed, defineAsyncComponent, defineAsyncComponent, onMounted, ref } from 'vue';`,
    `import { computed, defineAsyncComponent, onMounted, ref } from 'vue';`,
  );

  // 去掉非首屏静态导入。
  content = replaceAll(
    content,
    `import AiProviderSettings from '@/components/business/ai/provider/AiProviderSettings.vue';
`,
    '',
  );

  content = replaceAll(
    content,
    `import AiWebSourcesPanel from '@/components/business/ai/web/AiWebSourcesPanel.vue';
`,
    '',
  );

  // 添加 async 组件。
  content = insertBefore(
    content,
    `const documentRef = computed(() => props.document);`,
    `const DeferredAiProviderSettings = defineAsyncComponent({
  loader: () => import('@/components/business/ai/provider/AiProviderSettings.vue'),
  suspensible: false,
});

const DeferredAiWebSourcesPanel = defineAsyncComponent({
  loader: () => import('@/components/business/ai/web/AiWebSourcesPanel.vue'),
  suspensible: false,
});

`,
    'AiAssistantPanel deferred components',
  );

  // 模板替换。
  content = replaceAll(content, `<AiWebSourcesPanel `, `<DeferredAiWebSourcesPanel `);
  content = replaceAll(content, `<AiProviderSettings `, `<DeferredAiProviderSettings `);

  writeText(relativePath, content, original);
};

const updateSuggestions = () => {
  const relativePath = 'src/composables/ai/useCopilotSuggestions.ts';
  ensureRepoFile(relativePath);

  const original = readText(relativePath);
  let content = original;

  // 引入 onMounted。
  content = replaceAll(
    content,
    `import { computed, onBeforeUnmount, type Ref, ref } from 'vue';`,
    `import { computed, onBeforeUnmount, onMounted, type Ref, ref } from 'vue';`,
  );

  content = replaceAll(
    content,
    `import { computed, onBeforeUnmount, onMounted, onMounted, type Ref, ref } from 'vue';`,
    `import { computed, onBeforeUnmount, onMounted, type Ref, ref } from 'vue';`,
  );

  // 添加后台延迟常量。
  if (!content.includes('BACKGROUND_POOL_START_DELAY_MS')) {
    content = replaceOne(
      content,
      `/** 建议标题最大展示长度，超出截断加省略号。 */
const TITLE_MAX_LENGTH = 15;`,
      `/** 建议标题最大展示长度，超出截断加省略号。 */
const TITLE_MAX_LENGTH = 15;
/** AI 面板先完成首帧展示，再在后台慢慢加载动态建议池。 */
const BACKGROUND_POOL_START_DELAY_MS = 1_200;`,
      'useCopilotSuggestions BACKGROUND_POOL_START_DELAY_MS',
    );
  }

  // 旧逻辑：setup 阶段立即 ensurePool。
  const immediateEnsurePoolBlock = `  ensurePool().catch((err) => {
    logger.warn({ event: 'copilotkit.suggestion_pool_load_failed', err });
  });

  onBeforeUnmount(() => {`;

  const deferredEnsurePoolBlock = `  onMounted(() => {
    // 动态建议池不是 AI 面板首屏必要内容：先显示静态兜底，等界面首帧稳定后
    // 再后台读取缓存 / 生成词池，避免挂载阶段唤醒 sidecar 或 narrator 小模型。
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensurePool();
    }, BACKGROUND_POOL_START_DELAY_MS);
  });

  onBeforeUnmount(() => {`;

  if (content.includes(immediateEnsurePoolBlock)) {
    content = content.replace(immediateEnsurePoolBlock, deferredEnsurePoolBlock);
  }

  writeText(relativePath, content, original);
};

const updateTokenContext = () => {
  const relativePath = 'src/composables/ai/useAiTokenContext.ts';
  ensureRepoFile(relativePath);

  const original = readText(relativePath);
  let content = original;

  // 去掉首屏静态 tokenlens。
  content = replaceAll(content, `import { getContext } from 'tokenlens';
`, '');

  content = replaceAll(
    content,
    `import { computed } from 'vue';`,
    `import { computed, onBeforeUnmount, ref, watch } from 'vue';`,
  );

  content = replaceAll(
    content,
    `import { computed, onBeforeUnmount, ref, watch, onBeforeUnmount, ref, watch } from 'vue';`,
    `import { computed, onBeforeUnmount, ref, watch } from 'vue';`,
  );

  const oldResolveMaxTokens = `const resolveMaxTokens = (modelId: string | undefined): number => {
  if (!modelId) {
    return 0;
  }

  // 优先用应用自己的模型目录(覆盖 Mastra 路由的别名/未来模型,tokenlens 目录可能不识别)。
  const catalogContextWindow = findModelContextWindow(modelId);
  if (isPositiveFiniteNumber(catalogContextWindow)) {
    return catalogContextWindow;
  }

  // 目录未命中或窗口未知时,兜底查 tokenlens;仍拿不到则返回 0(UI 显示"未知")。
  const context = getContext({ modelId });
  const maxTokens = [
    context.maxTotal,
    context.totalMax,
    context.combinedMax,
    context.maxInput,
    context.inputMax,
  ].find(isPositiveFiniteNumber);

  return maxTokens ?? 0;
};`;

  const newResolveMaxTokens = `type TTokenlensModule = typeof import('tokenlens');

let tokenlensModulePromise: Promise<TTokenlensModule> | null = null;

const loadTokenlensModule = (): Promise<TTokenlensModule> => {
  tokenlensModulePromise ??= import('tokenlens');
  return tokenlensModulePromise;
};

const resolveCatalogMaxTokens = (modelId: string | undefined): number => {
  if (!modelId) {
    return 0;
  }

  // 首屏只查应用自己的轻量模型目录，避免 AI 面板挂载时同步拉入 tokenlens。
  const catalogContextWindow = findModelContextWindow(modelId);
  return isPositiveFiniteNumber(catalogContextWindow) ? catalogContextWindow : 0;
};

const resolveTokenlensMaxTokens = async (modelId: string): Promise<number> => {
  const { getContext } = await loadTokenlensModule();
  const context = getContext({ modelId });
  const maxTokens = [
    context.maxTotal,
    context.totalMax,
    context.combinedMax,
    context.maxInput,
    context.inputMax,
  ].find(isPositiveFiniteNumber);

  return maxTokens ?? 0;
};`;

  if (content.includes(oldResolveMaxTokens)) {
    content = content.replace(oldResolveMaxTokens, newResolveMaxTokens);
  }

  const oldMaxTokensComputed = `  const maxTokens = computed(() => resolveMaxTokens(normalizedModelId.value));`;

  const newMaxTokensRef = `  const maxTokens = ref(0);
  let disposed = false;
  let maxTokensTimer: ReturnType<typeof setTimeout> | null = null;

  const clearMaxTokensTimer = (): void => {
    if (maxTokensTimer !== null) {
      clearTimeout(maxTokensTimer);
      maxTokensTimer = null;
    }
  };

  watch(
    normalizedModelId,
    (modelId) => {
      clearMaxTokensTimer();
      const catalogMaxTokens = resolveCatalogMaxTokens(modelId);
      maxTokens.value = catalogMaxTokens;

      if (!modelId || catalogMaxTokens > 0) {
        return;
      }

      // tokenlens 只作为首屏后的兜底目录：不阻塞 AI 主界面初次显示。
      maxTokensTimer = setTimeout(() => {
        maxTokensTimer = null;
        void resolveTokenlensMaxTokens(modelId)
          .then((resolvedMaxTokens) => {
            if (!disposed && normalizedModelId.value === modelId && resolvedMaxTokens > 0) {
              maxTokens.value = resolvedMaxTokens;
            }
          })
          .catch(() => undefined);
      }, 1_200);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    disposed = true;
    clearMaxTokensTimer();
  });`;

  if (content.includes(oldMaxTokensComputed)) {
    content = content.replace(oldMaxTokensComputed, newMaxTokensRef);
  }

  writeText(relativePath, content, original);
};

const main = () => {
  const requiredFiles = [
    'src/components/business/ai/chat/AiPromptInput.vue',
    'src/components/business/ai/shell/AiWorkspaceSurface.vue',
    'src/components/business/ai/shell/AiAssistantPanel.vue',
    'src/composables/ai/useCopilotSuggestions.ts',
    'src/composables/ai/useAiTokenContext.ts',
  ];

  requiredFiles.forEach(ensureRepoFile);

  updatePromptInput();
  updateWorkspaceSurface();
  updateAssistantPanel();
  updateSuggestions();
  updateTokenContext();

  if (changedFiles.length === 0) {
    console.log('没有需要修改的内容：目标优化可能已经应用。');
    return;
  }

  console.log('已修改文件：');
  for (const file of changedFiles) {
    console.log(`- ${file}`);
  }

  console.log('\n建议验证：');
  console.log('pnpm typecheck');
  console.log('pnpm test -- src/composables/ai/useCopilotSuggestions.spec.ts src/components/business/ai/shell/AiWorkspaceSurface.spec.ts');
  console.log('pnpm build');

  console.log('\n查看改动：');
  console.log('git diff');

  console.log('\n回滚改动：');
  console.log(`git restore -- ${changedFiles.join(' ')}`);
};

main();