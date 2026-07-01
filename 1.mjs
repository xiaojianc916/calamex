// r3-acp-evict-thread-frontend.mjs
// 用法：先 pnpm tauri:dev 重新生成 src/bindings/tauri.ts（产出 commands.aiEvictThread），
//       再 node r3-acp-evict-thread-frontend.mjs [--write]，最后 pnpm lint && pnpm typecheck && pnpm test。
import { readFileSync, writeFileSync } from "node:fs";

const WRITE = process.argv.includes("--write");
const TYPES = "src/types/tauri/index.ts";
const TAURI_AI = "src/services/tauri/ai.ts";
const IPC_AI = "src/services/ipc/ai.service.ts";
const HISTORY = "src/composables/ai/useAiConversationHistory.ts";

const PLAN = {
	[TYPES]: [
		{
			before: `  aiCancel(payload: IAiCancelRequest): Promise<void>;`,
			after: `  aiCancel(payload: IAiCancelRequest): Promise<void>;
  aiEvictThread(threadId: string): Promise<void>;`,
		},
	],
	[TAURI_AI]: [
		{
			before: `  aiCancel: {
    command: 'ai_cancel',
    guardHint: '取消 AI 流式请求',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },`,
			after: `  aiCancel: {
    command: 'ai_cancel',
    guardHint: '取消 AI 流式请求',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: buildPayloadMetrics,
  },
  aiEvictThread: {
    command: 'ai_evict_thread',
    guardHint: '驱逐已删除对话的 ACP 会话态',
    audit: 'info',
    timeoutMs: 15_000,
  },`,
		},
		{
			before: `  | 'aiCancel'
`,
			after: `  | 'aiCancel'
  | 'aiEvictThread'
`,
		},
		{
			before: `  aiCancel: payloadCommand(AI_COMMAND_META.aiCancel, async (payload) => {
    await commands.aiCancel(payload);
  }),`,
			after: `  aiCancel: payloadCommand(AI_COMMAND_META.aiCancel, async (payload) => {
    await commands.aiCancel(payload);
  }),

  aiEvictThread: payloadCommand(AI_COMMAND_META.aiEvictThread, async (threadId: string) => {
    await commands.aiEvictThread(threadId);
  }),`,
		},
	],
	[IPC_AI]: [
		{
			before: `  cancel(payload: IAiCancelRequest): Promise<void> {
    return tauriService.aiCancel(payload);
  },`,
			after: `  cancel(payload: IAiCancelRequest): Promise<void> {
    return tauriService.aiCancel(payload);
  },
  /**
   * 驱逐某线程的 ACP 会话态（删除对话时调用）：令后端从 thread↔session / config_options /
   * available_commands 三张表移除该线程条目，根治其随会话数单调增长的内存泄漏。fire-and-forget。
   */
  evictThread(threadId: string): Promise<void> {
    return tauriService.aiEvictThread(threadId);
  },`,
		},
	],
	[HISTORY]: [
		{
			before: `import type { useAiAssistant } from '@/composables/ai/useAiAssistant';
import type { IAiThread } from '@/types/ai/thread';`,
			after: `import type { useAiAssistant } from '@/composables/ai/useAiAssistant';
import { aiService } from '@/services/ipc/ai.service';
import type { IAiThread } from '@/types/ai/thread';`,
		},
		{
			before: `    assistant.deleteConversation(threadId);
  };`,
			after: `    assistant.deleteConversation(threadId);
    // R3：删除对话即驱逐其后端 ACP 会话态（thread↔session / config_options / available_commands），
    // 根治这些按 thread/session 键的表随会话数单调增长的泄漏。fire-and-forget，不阻塞 UI。
    void aiService.evictThread(threadId);
  };`,
		},
	],
};

const files = {};
for (const path of Object.keys(PLAN)) {
	const raw = readFileSync(path, "utf8");
	files[path] = { isCRLF: raw.includes("\r\n"), src: raw.replace(/\r\n/g, "\n") };
}
if (files[HISTORY].src.includes("aiService.evictThread")) {
	console.log("[skip] 已应用过，幂等退出。");
	process.exit(0);
}
const errors = [];
for (const [path, hunks] of Object.entries(PLAN)) {
	for (const [i, h] of hunks.entries()) {
		const n = files[path].src.split(h.before).length - 1;
		if (n !== 1) errors.push(`${path} 第 ${i + 1} 个锚点命中 ${n} 次（需 1 次）`);
	}
}
if (errors.length) {
	console.error("[abort] 锚点核对失败，未写入任何文件：\n  - " + errors.join("\n  - "));
	process.exit(1);
}
for (const [path, hunks] of Object.entries(PLAN)) {
	let src = files[path].src;
	for (const h of hunks) src = src.split(h.before).join(h.after);
	files[path].out = files[path].isCRLF ? src.replace(/\n/g, "\r\n") : src;
}
if (WRITE) {
	for (const path of Object.keys(PLAN)) writeFileSync(path, files[path].out, "utf8");
	console.log("[written] 4 文件已更新。确保已 pnpm tauri:dev 重生成绑定，再跑 pnpm lint && pnpm typecheck && pnpm test。");
} else {
	console.log("[dry-run] 4 文件锚点各命中 1 次。加 --write 落盘。");
}