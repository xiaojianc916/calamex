#!/usr/bin/env node
// scripts/acp-usage-token-context-wiring.mjs
// 接收侧消费（ADR-20260617 · D7-⑦）：把已落地的 ACP 回合用量 VM（assistant.acpUsage.usage）
// 接进 AiAssistantPanel 的 tokenOfficialUsage，使 token 用量条优先反映 ACP usage_update。
// 单文件、单锚点、纯 ASCII 锚点；幂等（marker 命中即跳过）。
// 运行：node scripts/acp-usage-token-context-wiring.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/shell/AiAssistantPanel.vue';
const MARKER = 'const acpTurnUsage = assistant.acpUsage.usage.value;';

const ANCHOR = `const tokenOfficialUsage = computed(() => {
  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  return planStore.value.totalOfficialUsageResolved ? planStore.value.totalOfficialUsage : null;
});`;

const REPLACEMENT = `const tokenOfficialUsage = computed(() => {
  // 接收侧 ACP usage_update 闭环（ADR-20260617 · D7-⑦）：宿主已把 usage_update 投影为
  // 共享 IAiLanguageModelUsage VM。任一模式只要本回合有 ACP 用量就优先采用（chat / agent
  // 经 ACP host 上报）；其形状与外部 LanguageModelUsage 赋值兼容，可直接作为官方用量来源。
  const acpTurnUsage = assistant.acpUsage.usage.value;
  if (acpTurnUsage) {
    return acpTurnUsage;
  }

  if (assistant.activeMode.value !== 'plan') {
    return null;
  }

  return planStore.value.totalOfficialUsageResolved ? planStore.value.totalOfficialUsage : null;
});`;

function patchFile(file, marker, edits) {
  const raw = readFileSync(file, 'utf8');
  if (raw.includes(marker)) {
    console.log(`[skip] ${file} 已打过补丁`);
    return;
  }
  const hadCrlf = raw.includes('\r\n');
  let text = hadCrlf ? raw.replace(/\r\n/g, '\n') : raw;
  for (const [anchor, replacement, keyword] of edits) {
    const count = text.split(anchor).length - 1;
    if (count !== 1) {
      const ctx = text
        .split('\n')
        .filter((line) => line.includes(keyword))
        .slice(0, 8)
        .join('\n');
      throw new Error(
        `[${file}] anchor "${keyword}": expected 1 match but found ${count}\n--- context ---\n${ctx}`,
      );
    }
    text = text.replace(anchor, () => replacement);
  }
  const out = hadCrlf ? text.replace(/\n/g, '\r\n') : text;
  writeFileSync(file, out, 'utf8');
  console.log(`[ok] ${file} 已接线 ACP usage → tokenOfficialUsage`);
}

patchFile(FILE, MARKER, [[ANCHOR, REPLACEMENT, 'tokenOfficialUsage']]);