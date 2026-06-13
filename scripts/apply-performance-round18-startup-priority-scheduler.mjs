#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const fail = (filePath, message) => {
  throw new Error(`[${filePath}] ${message}`);
};

const read = (filePath) => readFileSync(resolve(root, filePath), 'utf8');
const write = (filePath, source) => writeFileSync(resolve(root, filePath), source, 'utf8');

const countRegexMatches = (source, pattern) => {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  return [...source.matchAll(globalPattern)].length;
};

const replaceOnce = (source, filePath, oldText, newText, label) => {
  if (source.includes(newText.trim())) {
    return source;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(filePath, `${label}: expected 1 match, got ${count}`);
  }

  return source.replace(oldText, newText);
};

const replaceRegexOnce = (source, filePath, pattern, replacement, label) => {
  if (source.includes(replacement.trim())) {
    return source;
  }

  const count = countRegexMatches(source, pattern);
  if (count !== 1) {
    fail(filePath, `${label}: expected 1 match, got ${count}`);
  }

  return source.replace(pattern, replacement);
};

// ---------------------------------------------------------------------------
// src/main.ts
// ---------------------------------------------------------------------------

{
  const filePath = 'src/main.ts';
  let source = read(filePath);

  // requestIdleCallback 不存在时，原 fallback 是 setTimeout(task, 0)，这会在首帧前抢主线程。
  // 改成按 timeout 让路，首屏阶段不跑 P2 任务。
  source = replaceOnce(
    source,
    filePath,
    `  // fallback：尽量让出首帧/输入事件
  setTimeout(task, 0);`,
    `  // fallback：不要在首帧前用 setTimeout(0) 抢主线程；给首屏、输入和窗口显示让路。
  setTimeout(task, timeoutMs);`,
    'delay idle fallback instead of setTimeout 0',
  );

  // 把命令目录预热从 bootstrap 早期变成“bootstrap/mount 后再 idle”。
  source = replaceRegexOnce(
    source,
    filePath,
    /    \/\/ 命令目录预热可能涉及较重的动态 import\/解析;放到 idle 时间，避免与首屏渲染抢主线程。\n    scheduleIdle\(\(\) => \{\n      markStartup\('shell-catalog-prefetch-start'\);\n      void import\('\.\/services\/shell\/command-catalog'\)\n        \.then\(\(\{ listShellCommandLabels \}\) => listShellCommandLabels\(\)\)\n        \.then\(\(\) => \{\n          markStartup\('shell-catalog-prefetch-done'\);\n        \}\)\n        \.catch\(\(error: unknown\) => \{\n          markStartup\('shell-catalog-prefetch-failed'\);\n          console\.warn\('命令目录预热失败', error\);\n        \}\);\n    \}\);\n    markStartup\('shell-catalog-prefetch-scheduled'\);\n\n/,
    `    const prefetchShellCatalogAfterBootstrap = (): void => {
      // 命令目录预热涉及动态 import/解析，属于 P2：必须等 Vue mount 和首屏任务让路后再 idle。
      scheduleIdle(() => {
        markStartup('shell-catalog-prefetch-start');
        void import('./services/shell/command-catalog')
          .then(({ listShellCommandLabels }) => listShellCommandLabels())
          .then(() => {
            markStartup('shell-catalog-prefetch-done');
          })
          .catch((error: unknown) => {
            markStartup('shell-catalog-prefetch-failed');
            console.warn('命令目录预热失败', error);
          });
      }, 2500);
      markStartup('shell-catalog-prefetch-scheduled');
    };

    const hydrateAiConversationAfterBootstrap = (): void => {
      // AI 历史不是首屏必需：延后到首屏后 idle，避免和 session hydrate / Vue mount 抢 IO。
      scheduleIdle(() => {
        void hydrateAiConversationStorage().catch((error: unknown) => {
          console.warn('AI 会话历史后台 hydrate 失败', error);
        });
      }, 2500);
    };

`,
    'move shell catalog and ai history to post-bootstrap helpers',
  );

  // session hydrate 阶段只保留真正首屏需要的 session storage。
  source = replaceOnce(
    source,
    filePath,
    `    markStartup('session-storage-hydrate-start');
    void hydrateAiConversationStorage().catch((error: unknown) => {
      console.warn('AI 会话历史后台 hydrate 失败', error);
    });
    await hydrateSessionStorage();
    markStartup('session-storage-hydrated');`,
    `    markStartup('session-storage-hydrate-start');
    await hydrateSessionStorage();
    markStartup('session-storage-hydrated');`,
    'remove immediate ai conversation hydrate from critical path',
  );

  // Vue mount 和基础系统初始化后，再调度 P2 任务。
  source = replaceOnce(
    source,
    filePath,
    `    initGitHubAuthHeaderEnhancement();
    initAppTooltipSystem();
    initEditorScrollbarActivity();
    markStartup('tooltip-system-ready');

    markStartup('bootstrap-done');`,
    `    initGitHubAuthHeaderEnhancement();
    initAppTooltipSystem();
    initEditorScrollbarActivity();
    markStartup('tooltip-system-ready');

    prefetchShellCatalogAfterBootstrap();
    hydrateAiConversationAfterBootstrap();

    markStartup('bootstrap-done');`,
    'schedule post-bootstrap background tasks',
  );

  write(filePath, source);
}

// ---------------------------------------------------------------------------
// src/views/ShellWorkbenchView.vue
// ---------------------------------------------------------------------------

{
  const filePath = 'src/views/ShellWorkbenchView.vue';
  let source = read(filePath);

  source = replaceOnce(
    source,
    filePath,
    `import { computed, defineAsyncComponent, nextTick, ref } from 'vue';`,
    `import { computed, defineAsyncComponent, nextTick, onMounted, ref } from 'vue';`,
    'import onMounted for post-mount ai prefetch',
  );

  // 原来模块求值期直接 prefetchAiSurfaceWhenIdle()。
  // 路由组件一加载就可能 schedule idle，仍可能早于首屏。
  // 改为组件 mounted 后再 schedule。
  source = replaceOnce(
    source,
    filePath,
    `prefetchAiSurfaceWhenIdle();

const emit = defineEmits<{`,
    `onMounted(() => {
  prefetchAiSurfaceWhenIdle();
});

const emit = defineEmits<{`,
    'move ai surface prefetch from module evaluation to mounted',
  );

  // requestIdleCallback fallback 也不要 setTimeout(0)。
  source = replaceOnce(
    source,
    filePath,
    `  window.setTimeout(prefetch, 0);`,
    `  window.setTimeout(prefetch, 2000);`,
    'delay ai prefetch fallback',
  );

  write(filePath, source);
}

// ---------------------------------------------------------------------------
// src/composables/useShellWorkbenchView.ts
// ---------------------------------------------------------------------------

{
  const filePath = 'src/composables/useShellWorkbenchView.ts';
  let source = read(filePath);

  // 增加启动期非关键任务调度器。
  source = replaceOnce(
    source,
    filePath,
    `const waitForInitialWorkbenchPaint = async (): Promise<void> =>
  new Promise((resolve) => {`,
    `const scheduleStartupNonCriticalTask = (task: () => void, timeoutMs = 1600): void => {
  if (typeof window === 'undefined') {
    return;
  }

  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return;
  }

  window.setTimeout(task, timeoutMs);
};

const waitForInitialWorkbenchPaint = async (): Promise<void> =>
  new Promise((resolve) => {`,
    'add startup non-critical task scheduler',
  );

  // native close listener 不需要抢首屏；延后绑定仍然足够早。
  source = replaceOnce(
    source,
    filePath,
    `    bindGlobalKeydownCapture();
    void bindNativeWindowCloseRequest();
    void initializeWorkbench();`,
    `    bindGlobalKeydownCapture();
    scheduleStartupNonCriticalTask(() => {
      void bindNativeWindowCloseRequest();
    }, 1800);
    void initializeWorkbench();`,
    'defer native close request binding',
  );

  write(filePath, source);
}

// ---------------------------------------------------------------------------
// src/composables/useWorkbench.ts
// ---------------------------------------------------------------------------

{
  const filePath = 'src/composables/useWorkbench.ts';
  let source = read(filePath);

  source = replaceOnce(
    source,
    filePath,
    `const WORKBENCH_RUNTIME_WAIT_MS = 160;`,
    `const WORKBENCH_RUNTIME_WAIT_MS = 160;
const EXECUTION_ENVIRONMENT_STARTUP_DELAY_MS = 900;`,
    'add execution environment startup delay constant',
  );

  // 执行环境检测是 P2：它影响“运行按钮是否可用”，但不该抢首屏和恢复 active tab。
  source = replaceOnce(
    source,
    filePath,
    `    cancelExecutionEnvironmentSyncTimer = runtimeScope.setTimeout(() => {
      cancelExecutionEnvironmentSyncTimer = null;
      void syncExecutionEnvironment();
    }, 0);`,
    `    cancelExecutionEnvironmentSyncTimer = runtimeScope.setTimeout(() => {
      cancelExecutionEnvironmentSyncTimer = null;
      void syncExecutionEnvironment();
    }, EXECUTION_ENVIRONMENT_STARTUP_DELAY_MS);`,
    'defer execution environment detection after startup',
  );

  write(filePath, source);
}

console.log('Applied round18 startup priority scheduler optimization.');
console.log('');
console.log('Touched:');
console.log(' - src/main.ts');
console.log(' - src/views/ShellWorkbenchView.vue');
console.log(' - src/composables/useShellWorkbenchView.ts');
console.log(' - src/composables/useWorkbench.ts');
console.log('');
console.log('What changed:');
console.log(' - AI conversation hydrate moved out of the startup critical path.');
console.log(' - Shell command catalog prefetch waits until after Vue mount/bootstrap basics.');
console.log(' - AI workspace/Copilot prefetch waits until ShellWorkbenchView mounted.');
console.log(' - Native close listener binding is delayed as a non-critical startup task.');
console.log(' - Execution environment detection is delayed so it does not compete with first paint/session restore.');
console.log(' - setTimeout(0) idle fallbacks no longer run before first paint.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Experience check:');
console.log('  pnpm dev');
console.log('  Watch startup logs in devtools console. First window reveal / workbench initial paint should be cleaner.');
console.log('');
console.log('Rollback:');
console.log('  git checkout -- src/main.ts src/views/ShellWorkbenchView.vue src/composables/useShellWorkbenchView.ts src/composables/useWorkbench.ts');