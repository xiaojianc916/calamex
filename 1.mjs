// fix-orphaned-resize-events-final.mjs —— 清除最后 2 个 window-resize-events 孤儿消费者
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = process.cwd();
const p = (rel) => resolve(root, rel);
const readLF = (rel) => {
  const abs = p(rel);
  if (!existsSync(abs)) throw new Error(`[缺失] ${rel} 不存在（是否在仓库根目录运行？）`);
  return readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
};

function scan(dir, needle, hits) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) scan(full, needle, hits);
    else if (/\.(ts|tsx|vue|js|mjs)$/.test(name)) {
      if (readFileSync(full, "utf8").includes(needle))
        hits.push(full.replace(root + "\\", "").replace(root + "/", ""));
    }
  }
}

const AIMD = "src/components/business/ai/chat/AiMarkdown.vue";
const CONV = "src/components/ai-elements/conversation/Conversation.vue";

const patches = [
  {
    file: AIMD,
    edits: [
      { old: `import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue';`,
        new: `import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';` },
      { old:
`import type { IAiChatStreamRenderState } from '@/types/ai';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';`,
        new: `import type { IAiChatStreamRenderState } from '@/types/ai';` },
      { old:
`const virtualState = ref<MarkstreamVirtualState | null>(null);
const isShellWindowResizing = ref(false);
const isLiveStream = computed(`,
        new:
`const virtualState = ref<MarkstreamVirtualState | null>(null);
const isLiveStream = computed(` },
      { old:
`const smoothStreaming = computed(() => {
  if (isShellWindowResizing.value) {
    return false;
  }

  return hasSeenLiveStream.value;
});`,
        new: `const smoothStreaming = computed(() => hasSeenLiveStream.value);` },
      { old:
`let pendingRenderContentTimer: ReturnType<typeof window.setTimeout> | null = null;
let resizeLifecycleCleanup: (() => void) | null = null;`,
        new: `let pendingRenderContentTimer: ReturnType<typeof window.setTimeout> | null = null;` },
      { old:
`  (nextContent) => {
    if (isShellWindowResizing.value) {
      pendingRenderContent = nextContent;
      return;
    }

    if (isFinal.value) {`,
        new:
`  (nextContent) => {
    if (isFinal.value) {` },
      { old:
`const bindResizeLifecycle = (): void => {
  const handleResizeStart = (): void => {
    isShellWindowResizing.value = true;
  };
  const handleResizeEnd = (): void => {
    isShellWindowResizing.value = false;
    window.requestAnimationFrame(flushPendingRenderContent);
  };

  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleResizeEnd);
  resizeLifecycleCleanup = () => {
    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleResizeEnd);
    resizeLifecycleCleanup = null;
  };
};

const stopCodeBlockMapping = watch(`,
        new: `const stopCodeBlockMapping = watch(` },
      { old:
`onMounted(() => {
  bindResizeLifecycle();
});

onBeforeUnmount(() => {
  clearPendingRenderContentTimer();
  resizeLifecycleCleanup?.();
  stopCodeBlockMapping();
  removeCustomComponents(rendererId.value);
});`,
        new:
`onBeforeUnmount(() => {
  clearPendingRenderContentTimer();
  stopCodeBlockMapping();
  removeCustomComponents(rendererId.value);
});` },
    ],
  },
  {
    file: CONV,
    edits: [
      { old: `import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';`,
        new: `import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';` },
      { old:
`import { cn } from '@/lib/utils';
import {
  SHELL_WINDOW_RESIZE_END_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
  SHELL_WINDOW_RESIZE_START_EVENT,
} from '@/utils/window/window-resize-events';`,
        new: `import { cn } from '@/lib/utils';` },
      { old:
`const isShellWindowResizing = ref(false);
const isScrollbarActive = ref(false);
const resolvedResize = computed(() => (isShellWindowResizing.value ? 'instant' : props.resize));
let scrollListenerCleanup: (() => void) | null = null;`,
        new:
`const isScrollbarActive = ref(false);
let scrollListenerCleanup: (() => void) | null = null;` },
      { old:
`let restoreFrame: number | null = null;
let resizeLifecycleCleanup: (() => void) | null = null;`,
        new: `let restoreFrame: number | null = null;` },
      { old:
`const bindResizeLifecycle = (): void => {
  const handleResizeStart = (): void => {
    isShellWindowResizing.value = true;
  };
  const handleResizeEnd = (): void => {
    isShellWindowResizing.value = false;
  };

  window.addEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
  window.addEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
  window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleResizeEnd);
  resizeLifecycleCleanup = () => {
    window.removeEventListener(SHELL_WINDOW_RESIZE_START_EVENT, handleResizeStart);
    window.removeEventListener(SHELL_WINDOW_RESIZE_END_EVENT, handleResizeEnd);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleResizeEnd);
    resizeLifecycleCleanup = null;
  };
};

onMounted(() => {
  bindResizeLifecycle();
  void nextTick(() => {
    bindScrollListener();
    void restoreScrollPosition();
  });
});`,
        new:
`onMounted(() => {
  void nextTick(() => {
    bindScrollListener();
    void restoreScrollPosition();
  });
});` },
      { old:
`  scrollListenerCleanup?.();
  scrollbarPointerCleanup?.();
  resizeLifecycleCleanup?.();
  cancelRestoreFrame();`,
        new:
`  scrollListenerCleanup?.();
  scrollbarPointerCleanup?.();
  cancelRestoreFrame();` },
      { old: `    :resize="resolvedResize"`,
        new: `    :resize="props.resize"` },
    ],
  },
];

function countOnce(content, old, label) {
  const n = content.split(old).length - 1;
  if (n !== 1) throw new Error(`[校验失败] ${label} 锚点出现 ${n} 次（应为 1）`);
}
for (const { file, edits } of patches) {
  let c = readLF(file);
  edits.forEach((e, i) => { countOnce(c, e.old, `${file} #${i + 1}`); c = c.replace(e.old, e.new); });
}
for (const { file, edits } of patches) {
  let c = readLF(file);
  for (const e of edits) c = c.replace(e.old, e.new);
  writeFileSync(p(file), c, "utf8");
}

console.log("✅ 已修补 AiMarkdown.vue 与 Conversation.vue。\n");
const a = []; scan(p("src"), "window-resize-events", a);
console.log(a.length === 0
  ? "🎉 src/ 下已无任何文件引用 window-resize-events。"
  : "⚠️ 仍引用 window-resize-events：\n  · " + a.join("\n  · "));
const b = []; scan(p("src"), "SHELL_WINDOW_RESIZE", b);
const cc = []; scan(p("src"), "isShellWindowResizing", cc);
if (b.length) console.log("⚠️ 仍残留 SHELL_WINDOW_RESIZE 符号：\n  · " + b.join("\n  · "));
if (cc.length) console.log("⚠️ 仍残留 isShellWindowResizing 符号：\n  · " + cc.join("\n  · "));
if (!b.length && !cc.length) console.log("🎉 无任何 SHELL_WINDOW_RESIZE / isShellWindowResizing 残留符号。");
console.log("\n下一步： pnpm vue-tsc --noEmit && pnpm test  然后重启 pnpm tauri dev");