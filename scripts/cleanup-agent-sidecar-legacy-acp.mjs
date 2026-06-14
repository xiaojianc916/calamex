import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const targetPath = path.resolve(root, 'src-tauri/src/agent_sidecar/mod.rs');
const scanRoots = [path.resolve(root, 'src-tauri/src')];
const textExtensions = new Set(['.rs', '.ts', '.tsx', '.js', '.mjs']);

const read = (file) => fs.readFileSync(file, 'utf8');
const write = (file, content) => fs.writeFileSync(file, content);

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

const countSymbolInRepo = (symbol) =>
  scanRoots
    .flatMap(walkFiles)
    .reduce((total, file) => total + countOccurrences(read(file), symbol), 0);

const assertMaxUsage = (symbol, maxCount) => {
  const count = countSymbolInRepo(symbol);
  if (count > maxCount) {
    throw new Error(`拒绝删除 ${symbol}: 仓库内仍有 ${count} 处引用，超过预期 ${maxCount}。`);
  }
};

const findFunctionRemovalStart = (content, functionStart) => {
  const markerIndex = content.indexOf(functionStart);
  if (markerIndex < 0) {
    return -1;
  }

  let lineStart = content.lastIndexOf('\n', markerIndex);
  lineStart = lineStart < 0 ? 0 : lineStart + 1;

  // 连同紧邻的 Rust doc comment 一起删除，避免留下悬空说明。
  let start = lineStart;
  while (start > 0) {
    const previousLineEnd = start - 1;
    const previousLineStart = content.lastIndexOf('\n', previousLineEnd - 1) + 1;
    const previousLine = content.slice(previousLineStart, previousLineEnd);
    if (previousLine.trim().startsWith('///') || previousLine.trim() === '') {
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

if (!fs.existsSync(targetPath)) {
  throw new Error(`未找到目标文件：${path.relative(root, targetPath)}`);
}

// 只删除已经不再被 ACP 路径使用的旧 HTTP/NDJSON 辅助；保留 sidecar 进程管理、
// 健康检查、warmup、approval/rollback/orchestrate 以及共享 streaming driver。
assertMaxUsage('answer_delta_text', 1);
assertMaxUsage('is_retryable_narrator_sidecar_error', 1);
assertMaxUsage('post_json_with_narrator_retry', 1);
assertMaxUsage('NARRATOR_CHAT_RETRY_DELAYS_MS', 3);

let content = read(targetPath);
const before = content;

content = content.replace(
  /const NARRATOR_CHAT_RETRY_DELAYS_MS: &\[u64\] = &\[[^\n]+\];\n/,
  '',
);
content = removeRustFunction(content, 'fn is_retryable_narrator_sidecar_error(');
content = removeRustFunction(content, 'async fn post_json_with_narrator_retry<');
content = removeRustFunction(content, 'pub fn answer_delta_text(');

if (content === before) {
  throw new Error('没有发生任何变更，拒绝写入。');
}

for (const forbidden of [
  'NARRATOR_CHAT_RETRY_DELAYS_MS',
  'is_retryable_narrator_sidecar_error',
  'post_json_with_narrator_retry',
  'answer_delta_text',
]) {
  if (content.includes(forbidden)) {
    throw new Error(`清理后仍残留：${forbidden}`);
  }
}

write(targetPath, content);
console.log('已清理 agent_sidecar 旧 HTTP/Narrator/answer_delta 辅助；保留 ACP sidecar 流式消费和进程管理路径。');
