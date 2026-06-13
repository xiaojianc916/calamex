#!/usr/bin/env node
// fix-known-vitest-failures.mjs
//
// 作用：批量修复一组确定性的 Vitest 失败（只改测试与测试桩，不碰高风险 ACP/chat 分叉逻辑）
// 用法：
//   node fix-known-vitest-failures.mjs
//
// 特点：
// - 幂等：已修改过则跳过
// - 无备份文件
// - 找不到预期旧内容时直接报错，避免误改

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

const files = [
  'src/App.spec.ts',
  'src/composables/useLsp.lifecycle.spec.ts',
  'src/store/aiConversation.store.spec.ts',
  'src/components/business/ai/chat/AiChatThread.spec.ts',
  'src/components/business/ai/shell/AiWebPreviewSidebar.spec.ts',
  'src/components/workbench/sidebar/explorer/__tests__/WorkspaceExplorerPanel.spec.ts',
];

for (const file of files) {
  const abs = resolve(ROOT, file);
  if (!existsSync(abs)) {
    throw new Error(`文件不存在：${file}\n请在仓库根目录执行该脚本。`);
  }
}

const read = (relPath) => readFileSync(resolve(ROOT, relPath), 'utf8');
const write = (relPath, content) => writeFileSync(resolve(ROOT, relPath), content, 'utf8');

const replaceOnce = (content, oldText, newText, label) => {
  if (content.includes(oldText)) {
    return content.replace(oldText, newText);
  }
  if (content.includes(newText)) {
    return content;
  }
  throw new Error(`未找到预期片段：${label}`);
};

const edit = (relPath, transform) => {
  const before = read(relPath);
  const after = transform(before);
  if (after !== before) {
    write(relPath, after);
    console.log(`✔ 已更新 ${relPath}`);
  } else {
    console.log(`• 已是目标状态 ${relPath}`);
  }
};

// -----------------------------------------------------------------------------
// 1) src/App.spec.ts
// -----------------------------------------------------------------------------
edit('src/App.spec.ts', (content) =>
  replaceOnce(
    content,
    "import App from '@/App.vue';",
    "import App from '@/app/App.vue';",
    'App.spec.ts App.vue 导入路径',
  ),
);

// -----------------------------------------------------------------------------
// 2) src/composables/useLsp.lifecycle.spec.ts
//    修复 fake timers 把 firstStart 一起推进导致 starting -> running 的断言失真
// -----------------------------------------------------------------------------
edit('src/composables/useLsp.lifecycle.spec.ts', (content) => {
  let next = content;

  next = replaceOnce(
    next,
    `  it('工作区切换时旧启动结果不会覆盖新生命周期', async () => {
    const firstStart = new Promise<void>((resolve) => setTimeout(resolve, 50));
    lspBridgeMock.start.mockReturnValueOnce(firstStart).mockResolvedValueOnce(undefined);`,
    `  it('工作区切换时旧启动结果不会覆盖新生命周期', async () => {
    let resolveFirstStart!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      resolveFirstStart = resolve;
    });
    lspBridgeMock.start.mockReturnValueOnce(firstStart).mockResolvedValueOnce(undefined);`,
    'useLsp 生命周期测试：firstStart 改为手动 deferred',
  );

  next = replaceOnce(
    next,
    `    await vi.advanceTimersByTimeAsync(50);`,
    `    resolveFirstStart();`,
    'useLsp 生命周期测试：不再推进 50ms timer',
  );

  return next;
});

// -----------------------------------------------------------------------------
// 3) src/store/aiConversation.store.spec.ts
//    滚动状态现在节流保存，测试需显式推进 timer
// -----------------------------------------------------------------------------
edit('src/store/aiConversation.store.spec.ts', (content) => {
  let next = content;

  next = replaceOnce(
    next,
    `import { beforeEach, describe, expect, it } from 'vitest';`,
    `import { beforeEach, describe, expect, it, vi } from 'vitest';`,
    'aiConversation.store.spec.ts 引入 vi',
  );

  next = replaceOnce(
    next,
    `  it('按会话保存滚动高度状态', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    const threadId = store.activeThreadId;
    store.updateThreadScrollState(threadId ?? '', {
      scrollTop: 320,
      scrollHeight: 1280,
      clientHeight: 640,
      distanceFromBottom: 320,
      updatedAt: '2026-05-10T12:00:00.000Z',
    });
    expect(store.activeThread?.scrollState).toEqual({
      scrollTop: 320,
      scrollHeight: 1280,
      clientHeight: 640,
      distanceFromBottom: 320,
      updatedAt: '2026-05-10T12:00:00.000Z',
    });
  });`,
    `  it('按会话保存滚动高度状态', async () => {
    vi.useFakeTimers();
    try {
      const store = useAiConversationStore();
      store.replaceMessages([createMessage(1)]);
      const threadId = store.activeThreadId;
      store.updateThreadScrollState(threadId ?? '', {
        scrollTop: 320,
        scrollHeight: 1280,
        clientHeight: 640,
        distanceFromBottom: 320,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });
      await vi.advanceTimersByTimeAsync(120);
      expect(store.activeThread?.scrollState).toEqual({
        scrollTop: 320,
        scrollHeight: 1280,
        clientHeight: 640,
        distanceFromBottom: 320,
        updatedAt: '2026-05-10T12:00:00.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });`,
    'aiConversation.store.spec.ts 滚动状态测试推进节流 timer',
  );

  return next;
});

// -----------------------------------------------------------------------------
// 4) src/components/business/ai/chat/AiChatThread.spec.ts
//    失败原因：后三个测试没带 threadStubs，且其中一个 stub props 写成了 messages
// -----------------------------------------------------------------------------
edit('src/components/business/ai/chat/AiChatThread.spec.ts', (content) => {
  let next = content;

  next = replaceOnce(
    next,
    `            props: ['messages', 'planDetails'],`,
    `            props: ['message', 'planDetails'],`,
    'AiChatThread.spec.ts planDetails stub props',
  );

  next = replaceOnce(
    next,
    `      global: {
        stubs: {
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            emits: ['changedFilesRollback', 'changedFilesPin'],
            template:
              "<div><button class=\\"cf-rollback\\" @click=\\"$emit('changedFilesRollback', 'm1', 'sum1')\\"></button><button class=\\"cf-pin\\" @click=\\"$emit('changedFilesPin', 'm1', 'sum1', true)\\"></button></div>",
          },
        },
      },`,
    `      global: {
        stubs: {
          ...threadStubs,
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            emits: ['changedFilesRollback', 'changedFilesPin'],
            template:
              "<div><button class=\\"cf-rollback\\" @click=\\"$emit('changedFilesRollback', 'm1', 'sum1')\\"></button><button class=\\"cf-pin\\" @click=\\"$emit('changedFilesPin', 'm1', 'sum1', true)\\"></button></div>",
          },
        },
      },`,
    'AiChatThread.spec.ts changed-files 测试补全 threadStubs',
  );

  next = replaceOnce(
    next,
    `      global: {
        stubs: {
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            props: ['message', 'planDetails'],
            template: '<div class="timeline-stub" />',
          },
        },
      },`,
    `      global: {
        stubs: {
          ...threadStubs,
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            props: ['message', 'planDetails'],
            template: '<div class="timeline-stub" />',
          },
        },
      },`,
    'AiChatThread.spec.ts planDetails 测试补全 threadStubs',
  );

  next = replaceOnce(
    next,
    `      global: {
        stubs: {
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            emits: [
              'planApprove',
              'planReject',
              'planRegenerate',
              'planUpdateStepTitle',
              'planRemoveStep',
            ],
            template: \`
              <div>
                <button class="plan-approve" @click="$emit('planApprove')"></button>
                <button class="plan-reject" @click="$emit('planReject')"></button>
                <button class="plan-regenerate" @click="$emit('planRegenerate')"></button>
                <button class="plan-update" @click="$emit('planUpdateStepTitle', 'step-1', '新标题')"></button>
                <button class="plan-remove" @click="$emit('planRemoveStep', 'step-2')"></button>
              </div>
            \`,
          },
        },
      },`,
    `      global: {
        stubs: {
          ...threadStubs,
          AiThreadVirtualMessageItem: {
            name: 'AiThreadVirtualMessageItem',
            emits: [
              'planApprove',
              'planReject',
              'planRegenerate',
              'planUpdateStepTitle',
              'planRemoveStep',
            ],
            template: \`
              <div>
                <button class="plan-approve" @click="$emit('planApprove')"></button>
                <button class="plan-reject" @click="$emit('planReject')"></button>
                <button class="plan-regenerate" @click="$emit('planRegenerate')"></button>
                <button class="plan-update" @click="$emit('planUpdateStepTitle', 'step-1', '新标题')"></button>
                <button class="plan-remove" @click="$emit('planRemoveStep', 'step-2')"></button>
              </div>
            \`,
          },
        },
      },`,
    'AiChatThread.spec.ts plan 事件测试补全 threadStubs',
  );

  return next;
});

// -----------------------------------------------------------------------------
// 5) src/components/business/ai/shell/AiWebPreviewSidebar.spec.ts
//    Console 现在默认折叠，文案也已改为中文
// -----------------------------------------------------------------------------
edit('src/components/business/ai/shell/AiWebPreviewSidebar.spec.ts', (content) => {
  let next = content;

  next = replaceOnce(
    next,
    `    expect(wrapper.get('[data-testid="web-preview-console"]').text()).toContain(
      'No console output yet',
    );`,
    `    expect(wrapper.get('[data-testid="web-preview-console"]').text()).toContain('Console');`,
    'AiWebPreviewSidebar.spec.ts 初始 console 文案断言',
  );

  next = replaceOnce(
    next,
    `  it('collapses the console body but keeps the header bar', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    expect(wrapper.find('.ai-web-preview-console__empty').exists()).toBe(true);

    await wrapper.get('[data-testid="web-preview-console-toggle"]').trigger('click');

    expect(wrapper.get('[data-testid="web-preview-console"]').exists()).toBe(true);
    expect(wrapper.find('.ai-web-preview-console__empty').exists()).toBe(false);
  });`,
    `  it('collapses the console body but keeps the header bar', async () => {
    const wrapper = mount(AiWebPreviewSidebar);

    expect(wrapper.get('[data-testid="web-preview-console"]').exists()).toBe(true);
    expect(wrapper.find('.ai-web-preview-console__empty').exists()).toBe(false);

    await wrapper.get('[data-testid="web-preview-console-toggle"]').trigger('click');

    expect(wrapper.get('[data-testid="web-preview-console"]').exists()).toBe(true);
    expect(wrapper.find('.ai-web-preview-console__empty').exists()).toBe(true);
    expect(wrapper.get('[data-testid="web-preview-console"]').text()).toContain('暂无应用日志');
  });`,
    'AiWebPreviewSidebar.spec.ts console 折叠/展开行为断言',
  );

  return next;
});

// -----------------------------------------------------------------------------
// 6) WorkspaceExplorerPanel.spec.ts
//    解决 LinearContextMenu mock 缺少 __isTeleport 导出
// -----------------------------------------------------------------------------
edit(
  'src/components/workbench/sidebar/explorer/__tests__/WorkspaceExplorerPanel.spec.ts',
  (content) =>
    replaceOnce(
      content,
      `vi.mock('@/components/common/LinearContextMenu.vue', () => ({
  default: { name: 'LinearContextMenu', render: () => null },
}));`,
      `vi.mock('@/components/common/LinearContextMenu.vue', () => ({
  __isTeleport: false,
  default: { name: 'LinearContextMenu', render: () => null },
}));`,
      'WorkspaceExplorerPanel.spec.ts LinearContextMenu mock',
    ),
);

console.log('\\n完成：已应用确定性的测试修复。');
console.log('注意：useAiAssistant 相关 ACP / legacy chat stream 分叉未在此脚本中处理。');