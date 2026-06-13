import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');
const write = (relativePath, content) => writeFileSync(join(root, relativePath), content, 'utf8');

const replaceOnce = (content, oldText, newText, label) => {
  if (!content.includes(oldText)) {
    throw new Error(`找不到待替换片段：${label}`);
  }

  return content.replace(oldText, newText);
};

const replaceAllChecked = (content, oldText, newText, label) => {
  const count = content.split(oldText).length - 1;

  if (count === 0) {
    throw new Error(`找不到待替换片段：${label}`);
  }

  return content.split(oldText).join(newText);
};

const patchUseLspSpec = () => {
  const file = 'src/composables/useLsp.lifecycle.spec.ts';
  let content = read(file);

  const flushBlock = `const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

`;

  const flushBlockPatched = `const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const startInitialLsp = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(1600);
  await flush();
};

`;

  if (!content.includes('const startInitialLsp = async (): Promise<void> => {')) {
    content = replaceOnce(content, flushBlock, flushBlockPatched, 'useLsp: 添加首次启动计时器 helper');
  }

  content = replaceAllChecked(
    content,
    `    scope.run(() => {
      lsp = useLsp(root);
    });
    await flush();
`,
    `    scope.run(() => {
      lsp = useLsp(root);
    });
    await startInitialLsp();
`,
    'useLsp: lsp 变量场景推进首次延迟启动',
  );

  content = replaceAllChecked(
    content,
    `    scope.run(() => {
      useLsp(root);
    });
    await flush();
`,
    `    scope.run(() => {
      useLsp(root);
    });
    await startInitialLsp();
`,
    'useLsp: 无返回值场景推进首次延迟启动',
  );

  write(file, content);
};

const patchAiChatThreadSpec = () => {
  const file = 'src/components/business/ai/chat/AiChatThread.spec.ts';
  let content = read(file);

  content = replaceOnce(
    content,
    `import { h } from 'vue';
`,
    `import { defineComponent, h, type PropType } from 'vue';
`,
    'AiChatThread.spec: Vue 测试工具导入',
  );

  content = content.replace(
    `import { Conversation } from '@/components/ai-elements/conversation';
`,
    '',
  );

  const oldTimelineStubBlock = `// 轻量替身:平铺时间线的逐条目渲染在 AiThreadTimeline.spec 中单独验证;此处只验证
// AiChatThread 传入的可见消息、逐消息 after-message 插槽与改动事件转发。
const TimelineStub = {
  name: 'AiThreadTimeline',
  props: ['messages'],
  template: \`
    <div class="timeline-stub">
      <div v-for="m in messages" :key="m.id" class="timeline-msg-stub" :data-message-id="m.id">
        <span class="timeline-msg-content" v-text="m.content"></span>
        <slot name="after-message" :message="m" />
      </div>
    </div>
  \`,
};

const stubTimeline = { AiThreadTimeline: TimelineStub };
`;

  const newThreadStubBlock = `// 轻量替身：真实滚动与逐条消息渲染分别在组件自身测试中覆盖；此处只验证
// AiChatThread 传入的可见消息、逐消息 after-message 插槽与事件转发。
const DynamicScrollerStub = defineComponent({
  name: 'DynamicScroller',
  props: {
    items: {
      type: Array as PropType<readonly unknown[]>,
      required: true,
    },
  },
  setup(props, { slots }) {
    return () =>
      h(
        'div',
        { class: 'ai-chat-list__scroller' },
        [
          ...props.items.flatMap(
            (item, index) => slots.default?.({ item, index, active: true }) ?? [],
          ),
          ...(slots.after?.() ?? []),
        ],
      );
  },
});

const DynamicScrollerItemStub = defineComponent({
  name: 'DynamicScrollerItem',
  props: {
    item: {
      type: Object as PropType<unknown>,
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    sizeDependencies: {
      type: Array as PropType<readonly unknown[]>,
      default: () => [],
    },
    emitResize: {
      type: Boolean,
      default: false,
    },
  },
  setup(_props, { slots }) {
    return () => h('div', { class: 'vue-recycle-scroller__item-view' }, slots.default?.());
  },
});

const VirtualMessageItemStub = {
  name: 'AiThreadVirtualMessageItem',
  props: [
    'message',
    'workspaceRootPath',
    'planDetails',
    'revertingChangedFilesSummaryId',
    'pinningChangedFilesSummaryId',
  ],
  emits: [
    'changedFilesRollback',
    'changedFilesPin',
    'planApprove',
    'planReject',
    'planRegenerate',
    'planUpdateStepTitle',
    'planRemoveStep',
  ],
  template: \`
    <div class="timeline-msg-stub" :data-message-id="message.id">
      <span class="timeline-msg-content" v-text="message.content"></span>
      <slot name="after-message" :message="message" />
      <button class="cf-rollback" @click="$emit('changedFilesRollback', 'm1', 'sum1')"></button>
      <button class="cf-pin" @click="$emit('changedFilesPin', 'm1', 'sum1', true)"></button>
      <button class="plan-approve" @click="$emit('planApprove')"></button>
      <button class="plan-reject" @click="$emit('planReject')"></button>
      <button class="plan-regenerate" @click="$emit('planRegenerate')"></button>
      <button class="plan-update" @click="$emit('planUpdateStepTitle', 'step-1', '新标题')"></button>
      <button class="plan-remove" @click="$emit('planRemoveStep', 'step-2')"></button>
    </div>
  \`,
};

const threadStubs = {
  DynamicScroller: DynamicScrollerStub,
  DynamicScrollerItem: DynamicScrollerItemStub,
  AiThreadVirtualMessageItem: VirtualMessageItemStub,
};
`;

  content = replaceOnce(
    content,
    oldTimelineStubBlock,
    newThreadStubBlock,
    'AiChatThread.spec: 替换旧 timeline stub',
  );

  content = replaceAllChecked(
    content,
    'stubTimeline',
    'threadStubs',
    'AiChatThread.spec: 使用当前虚拟消息 stub',
  );

  content = replaceAllChecked(
    content,
    'AiThreadTimeline',
    'AiThreadVirtualMessageItem',
    'AiChatThread.spec: 自定义 stub 名称迁移',
  );

  content = replaceOnce(
    content,
    `    expect(wrapper.findComponent(Conversation).props('resize')).toBeUndefined();
`,
    `    expect(wrapper.findComponent({ name: 'DynamicScrollerItem' }).props('emitResize')).toBe(true);
`,
    'AiChatThread.spec: typing resize 断言迁移',
  );

  content = replaceOnce(
    content,
    `    expect(wrapper.findComponent(Conversation).props('resize')).toBe('instant');
`,
    `    expect(wrapper.findComponent({ name: 'DynamicScroller' }).exists()).toBe(true);
`,
    'AiChatThread.spec: typing 结束后结构断言迁移',
  );

  write(file, content);
};

const patchAiChatThreadVue = () => {
  const file = 'src/components/business/ai/chat/AiChatThread.vue';
  let content = read(file);

  if (!content.includes('class="ai-chat-list overflow-x-hidden"')) {
    content = replaceOnce(
      content,
      `    class="ai-chat-list"
`,
      `    class="ai-chat-list overflow-x-hidden"
`,
      'AiChatThread.vue: 外层容器锁定横向溢出 class',
    );
  }

  write(file, content);
};

patchUseLspSpec();
patchAiChatThreadSpec();
patchAiChatThreadVue();

console.log('已完成测试失败修复脚本改动。');