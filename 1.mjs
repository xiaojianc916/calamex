#!/usr/bin/env node
// scripts/remove-window-resize-event-bus.mjs
//
// Phase B —— 彻底移除自造的全局 window-resize 事件总线。
// 目标架构：各组件用自己的 ResizeObserver 自管布局；is-resizing 仅作为唯一
// 合法的全局“过渡冻结”开关保留。无兼容层、无新旧杂糅。
//
// fail-fast：使用精确锚点；锚点缺失或非唯一即报错中止（重复运行安全）。
// 用法：node scripts/remove-window-resize-event-bus.mjs

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const p = (rel) => resolve(root, rel);

const WINDOW_RESIZE_STATE_SPEC = `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useWindowResizeState } from './useWindowResizeState';

type TResizeObserverCallback = () => void;

let capturedCallback: TResizeObserverCallback | null = null;

vi.mock('@vueuse/core', () => ({
  useResizeObserver: (_target: unknown, callback: TResizeObserverCallback) => {
    capturedCallback = callback;
    return { stop: vi.fn() };
  },
}));

const isResizing = (): boolean => document.documentElement.classList.contains('is-resizing');
const fireResize = (): void => {
  capturedCallback?.();
};

describe('useWindowResizeState（ResizeObserver 驱动）', () => {
  let scope: ReturnType<typeof effectScope> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    capturedCallback = null;
    document.documentElement.classList.remove('is-resizing');
    scope = effectScope();
    scope.run(() => {
      useWindowResizeState();
    });
  });

  afterEach(() => {
    scope?.stop();
    scope = null;
    document.documentElement.classList.remove('is-resizing');
    vi.useRealTimers();
  });

  it('ResizeObserver 回调触发后立即标记 is-resizing', () => {
    fireResize();
    expect(isResizing()).toBe(true);
  });

  it('停止收到新回调超过去抖时长后自动移除 is-resizing，无需任何看门狗', () => {
    fireResize();
    vi.advanceTimersByTime(120);
    expect(isResizing()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(isResizing()).toBe(false);
  });

  it('连续多次回调期间持续在场，每次都会重置去抖计时器', () => {
    fireResize();
    vi.advanceTimersByTime(120);
    fireResize();
    vi.advanceTimersByTime(120);
    expect(isResizing()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(isResizing()).toBe(false);
  });

  it('作用域销毁时立即清理 is-resizing 状态', () => {
    fireResize();
    expect(isResizing()).toBe(true);
    scope?.stop();
    expect(isResizing()).toBe(false);
  });
});
`;

const WINDOW_CONSTANTS_SPEC = `import { describe, expect, it } from 'vitest';
import { MAIN_WINDOW_LABEL } from '@/utils/window/app-window';

describe('窗口相关常量契约', () => {
  it('主窗口标签固定为 main', () => {
    expect(MAIN_WINDOW_LABEL).toBe('main');
  });
});
`;

const ops = [
  // ── 1. useWindowResizeState.ts：只保留 is-resizing 冻结，去掉事件派发 ──
  {
    file: 'src/composables/useWindowResizeState.ts',
    kind: 'edit',
    replacements: [
      {
        find: `import { requestDisposableTimeout } from '@/utils/platform/dom-lifecycle';
import {
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
} from '@/utils/window/window-resize-events';
`,
        replace: `import { requestDisposableTimeout } from '@/utils/platform/dom-lifecycle';
`,
      },
      {
        find: `        settleTimer.clear();
        html.classList.remove('is-resizing');
        window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_SETTLED_EVENT));
      }, RESIZE_SETTLE_DELAY_MS),`,
        replace: `        settleTimer.clear();
        html.classList.remove('is-resizing');
      }, RESIZE_SETTLE_DELAY_MS),`,
      },
      {
        find: `  useResizeObserver(html, () => {
    html.classList.add('is-resizing');
    window.dispatchEvent(new Event(SHELL_WINDOW_RESIZE_FRAME_EVENT));
    scheduleSettle();
  });`,
        replace: `  useResizeObserver(html, () => {
    html.classList.add('is-resizing');
    scheduleSettle();
  });`,
      },
    ],
  },

  // ── 2. useShellWorkbenchView.ts：删除总线订阅与 editor live-resize 转发 ──
  {
    file: 'src/app/composables/useShellWorkbenchView.ts',
    kind: 'edit',
    replacements: [
      {
        find: `import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window/window-close';
import {
  SHELL_WINDOW_RESIZE_FRAME_EVENT,
  SHELL_WINDOW_RESIZE_SETTLED_EVENT,
} from '@/utils/window/window-resize-events';
`,
        replace: `import { consumeProgrammaticWindowCloseAllowance } from '@/utils/window/window-close';
`,
      },
      {
        find: `  let editorLayoutAfterSidebarFrameId: number | null = null;
  let editorLiveResizeFrameId: number | null = null;
  let globalKeydownCleanup: (() => void) | null = null;`,
        replace: `  let editorLayoutAfterSidebarFrameId: number | null = null;
  let globalKeydownCleanup: (() => void) | null = null;`,
      },
      {
        find: `  const {
    diagnosticsTransitionsEnabled,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    handleShellWindowResizeFrame,
    handleShellWindowResizeSettled,
    mount: mountViewportState,
    cleanup: cleanupViewportState,
  } = useShellWorkbenchViewportState({ editorViewportRef });

  const scheduleEditorLayoutDuringWindowResize = (): void => {
    if (editorLiveResizeFrameId !== null) {
      return;
    }

    editorLiveResizeFrameId = window.requestAnimationFrame(() => {
      editorLiveResizeFrameId = null;
      editorRef.value?.layoutEditor();
    });
  };

  const handleShellWindowResizeFrameEvent = (): void => {
    handleShellWindowResizeFrame();
    scheduleEditorLayoutDuringWindowResize();
  };

`,
        replace: `  const {
    diagnosticsTransitionsEnabled,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    mount: mountViewportState,
    cleanup: cleanupViewportState,
  } = useShellWorkbenchViewportState({ editorViewportRef });

`,
      },
      {
        find: `    markStartup('shell-workbench-mounted');
    window.addEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.addEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);

    mountViewportState();`,
        replace: `    markStartup('shell-workbench-mounted');

    mountViewportState();`,
      },
      {
        find: `    isUnmounted = true;
    window.removeEventListener(SHELL_WINDOW_RESIZE_FRAME_EVENT, handleShellWindowResizeFrameEvent);
    window.removeEventListener(SHELL_WINDOW_RESIZE_SETTLED_EVENT, handleShellWindowResizeSettled);
    globalKeydownCleanup?.();`,
        replace: `    isUnmounted = true;
    globalKeydownCleanup?.();`,
      },
      {
        find: `    if (editorLayoutAfterSidebarFrameId !== null) {
      window.cancelAnimationFrame(editorLayoutAfterSidebarFrameId);
      editorLayoutAfterSidebarFrameId = null;
    }

    if (editorLiveResizeFrameId !== null) {
      window.cancelAnimationFrame(editorLiveResizeFrameId);
      editorLiveResizeFrameId = null;
    }
  });`,
        replace: `    if (editorLayoutAfterSidebarFrameId !== null) {
      window.cancelAnimationFrame(editorLayoutAfterSidebarFrameId);
      editorLayoutAfterSidebarFrameId = null;
    }
  });`,
      },
    ],
  },

  // ── 3. useShellWorkbenchViewportState.ts：删除总线 handler + 冗余 queueCurrentViewportSize ──
  {
    file: 'src/app/composables/useShellWorkbenchViewportState.ts',
    kind: 'edit',
    replacements: [
      {
        find: `  const queueCurrentViewportSize = (): void => {
    const snapshot = captureCurrentViewportSize();
    if (!snapshot) return;
    queueEditorViewportResize(snapshot.width, snapshot.height);
  };

  const handleShellWindowResizeFrame = (): void => {
    diagnosticsTransitionsEnabled.value = false;
    queueCurrentViewportSize();
  };

  const handleShellWindowResizeSettled = (): void => {
    if (editorViewportResizeFrameId !== null) {
      window.cancelAnimationFrame(editorViewportResizeFrameId);
      editorViewportResizeFrameId = null;
    }
    const snapshot = captureCurrentViewportSize();
    if (snapshot) {
      pendingEditorViewportSize = snapshot;
    }
    flushEditorViewportResize();
    scheduleDiagnosticsTransitionRestore();
  };

  const mount = (): void => {`,
        replace: `  const mount = (): void => {`,
      },
      {
        find: `  return {
    editorViewportWidth,
    diagnosticsTransitionsEnabled,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    handleShellWindowResizeFrame,
    handleShellWindowResizeSettled,
    mount,
    cleanup,
  };`,
        replace: `  return {
    editorViewportWidth,
    diagnosticsTransitionsEnabled,
    diagnosticsPanelMotionClass,
    diagnosticsPanelStyle,
    mount,
    cleanup,
  };`,
      },
    ],
  },

  // ── 4. 删除总线模块本身 ──
  { file: 'src/utils/window/window-resize-events.ts', kind: 'delete' },

  // ── 5 & 6. 重写两个引用了总线的 spec ──
  { file: 'src/composables/useWindowResizeState.spec.ts', kind: 'rewrite', content: WINDOW_RESIZE_STATE_SPEC },
  { file: 'src/utils/window/window-constants.spec.ts', kind: 'rewrite', content: WINDOW_CONSTANTS_SPEC },
];

// ── pass 1: 校验 ───────────────────────────────────────────
const planned = [];
for (const op of ops) {
  const abs = p(op.file);
  if (op.kind === 'delete') {
    if (!existsSync(abs)) throw new Error(`[校验失败] 待删除文件不存在: ${op.file}`);
    planned.push({ ...op, abs });
    continue;
  }
  if (op.kind === 'rewrite') {
    if (!existsSync(abs)) throw new Error(`[校验失败] 待重写文件不存在: ${op.file}`);
    planned.push({ ...op, abs });
    continue;
  }
  let text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  for (const { find } of op.replacements) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      throw new Error(`[校验失败] ${op.file} 中锚点出现 ${count} 次（应为 1）:\n---\n${find}\n---`);
    }
  }
  planned.push({ ...op, abs });
}

// ── pass 2: 落盘 ───────────────────────────────────────────
for (const op of planned) {
  if (op.kind === 'delete') {
    rmSync(op.abs);
    console.log(`🗑️  已删除 ${op.file}`);
    continue;
  }
  if (op.kind === 'rewrite') {
    writeFileSync(op.abs, op.content, 'utf8');
    console.log(`♻️  已重写 ${op.file}`);
    continue;
  }
  let text = readFileSync(op.abs, 'utf8').replace(/\r\n/g, '\n');
  for (const { find, replace } of op.replacements) text = text.replace(find, replace);
  writeFileSync(op.abs, text, 'utf8');
  console.log(`✏️  已修改 ${op.file}（${op.replacements.length} 处）`);
}

console.log(`\n✅ 事件总线已整根移除。请务必验证：`);
console.log(`   pnpm vue-tsc --noEmit && pnpm test`);
console.log(`   然后手动拖拽窗口边缘，确认内部 UI 跟手、无漏底、无残留过渡抖动。`);