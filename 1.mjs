// 1.mjs — Step 8 砖3③ 流式写真源切到 authoritative entries store（行为等价、可逆）
// 运行：node 1.mjs  （仓库根目录 D:\com.xiaojianc\my_desktop_app）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const storePath = resolve(root, 'src/store/aiThread/index.ts');
const composablePath = resolve(root, 'src/composables/ai/useAiAssistant.ts');

function replaceOnce(content, oldStr, newStr, label) {
  const parts = content.split(oldStr);
  if (parts.length !== 2) {
    throw new Error(`[${label}] 期望命中 1 处锚点，实际命中 ${parts.length - 1} 处`);
  }
  return parts[0] + newStr + parts[1];
}

// ── 1) store：新增 setStreamingActiveThread + 导出 ───────────────────────────
let store = readFileSync(storePath, 'utf8');

const setLiveThreadBlock = [
  '  function setLiveThread(thread: IAiThread | null): void {',
  '    liveThread.value = thread;',
  '  }',
].join('\n');

const setLiveThreadBlockWithStreaming = [
  setLiveThreadBlock,
  '',
  '  /**',
  '   * Step 8 砖3③：流式写真源 → 权威 entries 覆盖。',
  '   * 把本回合 reduce 回放得到的 IAiThread（buildLiveThreadFromSidecarEvents =',
  '   * reduceThreadAll 纯回放）作为权威活动线程覆盖，使 renderActiveThread 优先渲染',
  '   * 权威 entries。thread 为 null 表示本回合收尾：复位为单空线程，渲染回落到响应式',
  '   * legacy 投影（activeThread）。与既有 liveThread 覆盖机制按构造等价',
  '   * （selectRenderThread：非空权威胜出，否则回退），故零行为变化。',
  '   */',
  '  function setStreamingActiveThread(thread: IAiThread | null): void {',
  '    if (!thread) {',
  '      commitAuthoritativeState(threadMutations.ensureActiveThread(null, []));',
  '      return;',
  '    }',
  '    commitAuthoritativeState(',
  '      threadMutations.commitThreadsState({ threads: [thread], activeThreadId: thread.id }),',
  '    );',
  '  }',
].join('\n');

store = replaceOnce(store, setLiveThreadBlock, setLiveThreadBlockWithStreaming, 'store-setStreamingActiveThread-def');

store = replaceOnce(
  store,
  ['    // actions', '    setLiveThread,'].join('\n'),
  ['    // actions', '    setLiveThread,', '    setStreamingActiveThread,'].join('\n'),
  'store-setStreamingActiveThread-export',
);

writeFileSync(storePath, store, 'utf8');

// ── 2) useAiAssistant：流式/收尾两处由 setLiveThread 切到 setStreamingActiveThread ──
let composable = readFileSync(composablePath, 'utf8');

composable = replaceOnce(
  composable,
  '    aiThreadStore.setLiveThread(\n      buildLiveThreadFromSidecarEvents(events, {',
  '    aiThreadStore.setStreamingActiveThread(\n      buildLiveThreadFromSidecarEvents(events, {',
  'composable-streaming-bridge',
);

composable = replaceOnce(
  composable,
  '      aiThreadStore.setLiveThread(null);',
  '      aiThreadStore.setStreamingActiveThread(null);',
  'composable-rest-reset',
);

writeFileSync(composablePath, composable, 'utf8');

console.log('✓ Step 8 砖3③ 完成：流式写真源切到 authoritative entries store（store + useAiAssistant）');