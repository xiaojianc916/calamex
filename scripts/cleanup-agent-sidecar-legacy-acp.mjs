import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetPath = path.resolve(root, 'src-tauri/src/agent_sidecar/mod.rs');
const scanRoots = [path.resolve(root, 'src-tauri/src')];
const textExtensions = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs']);
const legacySymbols = [
  'answer_delta_text',
  'is_retryable_narrator_sidecar_error',
  'post_json_with_narrator_retry',
  'NARRATOR_CHAT_RETRY_DELAYS_MS',
  'model_chat_streaming',
  'model_chat_once',
  'narrator_model_chat_once',
];

const read = (file) => fs.readFileSync(file, 'utf8');
const write = (file, content) => fs.writeFileSync(file, content);

const normalizePath = (file) => path.resolve(file).replaceAll('\\\\', '/');
const targetKey = normalizePath(targetPath);

const walkFiles = (directory) => {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      result.push(fullPath);
    }
  }
  return result;
};

const countOccurrences = (content, needle) => {
  let count = 0;
  let offset = 0;
  while (true) {
    const next = content.indexOf(needle, offset);
    if (next < 0) {
      return count;
    }
    count += 1;
    offset = next + needle.length;
  }
};

const externalUsages = (symbol) =>
  scanRoots
    .flatMap(walkFiles)
    .filter((file) => normalizePath(file) !== targetKey)
    .map((file) => ({
      file,
      count: countOccurrences(read(file), symbol),
    }))
    .filter((item) => item.count > 0);

const assertNoExternalUsage = (symbol) => {
  const usages = externalUsages(symbol);
  if (usages.length > 0) {
    const summary = usages
      .map((item) => `${path.relative(root, item.file)}(${item.count})`)
      .join(', ');
    throw new Error(`拒绝删除 ${symbol}: 目标文件外仍有引用：${summary}`);
  }
};

const findFunctionRemovalStart = (content, functionStart) => {
  const markerIndex = content.indexOf(functionStart);
  if (markerIndex < 0) {
    return -1;
  }

  let lineStart = content.lastIndexOf('\n', markerIndex);
  lineStart = lineStart < 0 ? 0 : lineStart + 1;

  // 连同紧邻的 Rust doc comment / attribute 一起删除，避免留下悬空说明或 dead_code 属性。
  let start = lineStart;
  while (start > 0) {
    const previousLineEnd = start - 1;
    const previousLineStart = content.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const previousLine = content.slice(previousLineStart, previousLineEnd);
    const trimmed = previousLine.trim();
    if (trimmed.startsWith('///') || trimmed.startsWith('#[') || trimmed === '') {
      start = previousLineStart;
      continue;
    }
    break;
  }

  return start;
};

const removeRustFunction = (content, functionStart) => {
  const markerIndex = content.indexOf(functionStart);
  if (markerIndex < 0) {
    return content;
  }

  const start = findFunctionRemovalStart(content, functionStart);
  const bodyStart = content.indexOf('{', markerIndex);
  if (bodyStart < 0) {
    throw new Error(`未找到函数体起点：${functionStart}`);
  }

  let depth = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString = false;
  let previous = '';

  for (let index = bodyStart; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
      }
      previous = char;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
        previous = '/';
        continue;
      }
      previous = char;
      continue;
    }

    if (inString) {
      if (char === '"' && previous !== '\\') {
        inString = false;
      }
      previous = char;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      previous = '/';
      continue;
    }

    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      previous = '*';
      continue;
    }

    if (char === '"') {
      inString = true;
      previous = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = index + 1;
        if (content[end] === '\r') end += 1;
        if (content[end] === '\n') end += 1;
        return `${content.slice(0, start)}${content.slice(end)}`;
      }
    }

    previous = char;
  }

  throw new Error(`未找到函数体终点：${functionStart}`);
};

const removeTestFunction = (content, testName) => {
  const escaped = testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return removeRustFunction(content, `fn ${testName}(`).replace(
    new RegExp(`\\n\\s*#\\[test\\]\\n\\s*fn ${escaped}\\(`),
    `\n    fn ${testName}(`,
  );
};

if (!fs.existsSync(targetPath)) {
  throw new Error(`未找到目标文件：${path.relative(root, targetPath)}`);
}

// 只删除已经不再被 ACP 路径使用的旧 HTTP/NDJSON 辅助；保留 sidecar 进程管理、
// 健康检查、warmup、approval/rollback/orchestrate 以及共享 streaming driver。
for (const symbol of legacySymbols) {
  assertNoExternalUsage(symbol);
}

let content = read(targetPath);
const before = content;

content = content.replace(
  /const NARRATOR_CHAT_RETRY_DELAYS_MS: &\[u64\] = &\[[^\n]+\];\n/,
  '',
);

for (const functionStart of [
  'fn is_retryable_narrator_sidecar_error(',
  'async fn post_json_with_narrator_retry<',
  'pub fn answer_delta_text(',
  'pub async fn model_chat_streaming<',
  'pub async fn model_chat_once(',
  'pub async fn narrator_model_chat_once(',
]) {
  content = removeRustFunction(content, functionStart);
}

// 同文件单测引用会被一起删除；这些测试覆盖的是已删除旧 helper，而不是仍在用的 ACP 路径。
for (const testName of [
  'startup_not_ready_error_is_retryable',
  'answer_delta_text_extracts_only_final_phase_message_deltas',
  'crashed_sidecar_error_is_not_narrator_retryable',
]) {
  content = removeTestFunction(content, testName);
}

// 清理 tests import 列表里的已删除符号；保留 streaming driver / health / spawn 相关测试。
for (const symbol of [
  'answer_delta_text',
  'is_retryable_narrator_sidecar_error',
]) {
  content = content.replace(new RegExp(`\\b${symbol},\\s*`, 'g'), '');
  content = content.replace(new RegExp(`,\\s*${symbol}\\b`, 'g'), '');
}

// 删除函数后可能出现连续空行，收敛一下，避免格式化噪音过大。
content = content.replace(/\n{4,}/g, '\n\n\n');

if (content === before) {
  throw new Error('没有发生任何变更，拒绝写入。');
}

for (const forbidden of legacySymbols) {
  if (content.includes(forbidden)) {
    throw new Error(`清理后仍残留：${forbidden}`);
  }
}

write(targetPath, content);
console.log('已清理 agent_sidecar 旧 HTTP/Narrator/model_chat/answer_delta 辅助及对应旧单测；保留 ACP sidecar 流式消费和进程管理路径。');
