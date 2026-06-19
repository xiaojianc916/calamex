#!/usr/bin/env node
// probe-local.mjs —— 只读,打印本地真实文本片段
import fs from 'node:fs';
const show = (rel, from, to) => {
  const lines = fs.readFileSync(rel, 'utf8').replace(/\r\n/g, '\n').split('\n');
  console.log(`\n===== ${rel} [${from}-${to}] =====`);
  for (let i = from; i <= Math.min(to, lines.length); i++) {
    console.log(`${String(i).padStart(4)}| ${lines[i - 1]}`);
  }
};
// 确认 sidecar 分组 import 的范围
show('src/components/business/ai/chat/AiPromptInput.vue', 58, 72);
// 拿到本地 handleAgentBackendChange 完整函数体
show('src/components/business/ai/shell/AiAssistantPanel.vue', 708, 750);