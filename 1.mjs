#!/usr/bin/env node
// Step 7.4d: 接线 entries 双写镜像 (installEntriesMirror) 到应用引导。
// 仅改 src/app/main.ts：在 legacy hydrate + 读侧 runStartupPersistedRead 之后安装镜像。
// 非破坏式：双写只同步新 key 'shell-ide.ai-thread-entries'，不改渲染 SoT。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CHECK = process.argv.includes('--check');
const REPO_ROOT = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : process.cwd();
const target = join(REPO_ROOT, 'src/app/main.ts');

function replaceOnce(source, oldStr, newStr) {
  const idx = source.indexOf(oldStr);
  if (idx === -1) throw new Error('锚点未找到:\n' + oldStr);
  if (source.indexOf(oldStr, idx + oldStr.length) !== -1)
    throw new Error('锚点出现多次, 拒绝替换:\n' + oldStr);
  return source.slice(0, idx) + newStr + source.slice(idx + oldStr.length);
}

let content = readFileSync(target, 'utf8');
const before = content;

// 1) 追加 import（保持 @/ 内部 import 路径字母序：aiConversation < aiThread/...）。
content = replaceOnce(
  content,
  "import { pinia } from '@/store';\n" +
    "import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';",
  "import { pinia } from '@/store';\n" +
    "import { useAiConversationStore } from '@/store/aiConversation';\n" +
    "import { installEntriesMirror } from '@/store/aiThread/entriesMirrorBridge';\n" +
    "import { runStartupPersistedRead } from '@/store/aiThread/startupPersistedReadWiring';",
);

// 2) 读侧 hydrate 完成后安装双写镜像（时序安全：避免空态覆盖权威新 key）。
content = replaceOnce(
  content,
  "        void hydrateAiConversationStorage()\n" +
    "          .then(() => runStartupPersistedRead())\n" +
    "          .catch((error: unknown) => {",
  "        void hydrateAiConversationStorage()\n" +
    "          .then(() => runStartupPersistedRead())\n" +
    "          .then(() => {\n" +
    "            // 7.4d 双写接线：必须在 legacy hydrate + 读侧回退槽填充之后再装镜像，\n" +
    "            // 否则首次立即镜像会把空态写入权威新 key，导致下次启动读到“空且权威”而丢历史。\n" +
    "            installEntriesMirror(useAiConversationStore());\n" +
    "          })\n" +
    "          .catch((error: unknown) => {",
);

if (content === before) {
  console.log('无变化（可能已接线）:', target);
  process.exit(0);
}
if (CHECK) {
  console.log('[--check] 将更新:', target);
  process.exit(0);
}
writeFileSync(target, content, 'utf8');
console.log('已更新:', target);