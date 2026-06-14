import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const bindingPath = path.join(root, 'src/bindings/tauri.ts');
const knownGoodCommit = '76e92f18e835d45fc1f435c3952d800b2897c136';

const restoreBinding = () => {
  try {
    return execFileSync('git', ['show', `${knownGoodCommit}:src/bindings/tauri.ts`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法从 ${knownGoodCommit} 恢复 src/bindings/tauri.ts：${message}`);
  }
};

const replaceChatStreamSessionId = (content) => {
  const blockPattern = /export type AiChatStreamPayload = \{[\s\S]*?\n\};/u;
  const match = content.match(blockPattern);
  if (!match) {
    throw new Error('未找到 AiChatStreamPayload 类型块。');
  }

  const originalBlock = match[0];
  const updatedBlock = originalBlock.replace('\tsessionId: string | null,', '\tsessionId: string,');
  if (updatedBlock === originalBlock) {
    if (originalBlock.includes('\tsessionId: string,')) {
      return content;
    }
    throw new Error('AiChatStreamPayload.sessionId 不是预期的 string | null 形状。');
  }

  return content.replace(originalBlock, updatedBlock);
};

let content = restoreBinding();
content = replaceChatStreamSessionId(content);

if (!content.includes('export type AiChatStreamPayload = {')) {
  throw new Error('修复后的绑定缺少 AiChatStreamPayload。');
}
if (!content.includes('\tsessionId: string,\n};')) {
  throw new Error('修复后的绑定未把 AiChatStreamPayload.sessionId 改成 string。');
}
if (content.length < 50_000) {
  throw new Error(`修复后的绑定大小异常：${content.length} bytes。`);
}

fs.writeFileSync(bindingPath, content);
console.log('已从已知完整版本恢复 src/bindings/tauri.ts，并把 AiChatStreamPayload.sessionId 修为 string。');
