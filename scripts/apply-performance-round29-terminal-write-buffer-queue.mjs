import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const file = path.join(repoRoot, 'src/terminal/session.ts');

const fail = (message) => {
  throw new Error(message);
};

const replaceOnce = (source, search, replacement, label) => {
  const count = source.split(search).length - 1;

  if (count !== 1) {
    fail(`[${label}] expected 1 match, got ${count}`);
  }

  return source.replace(search, replacement);
};

const replaceAllChecked = (source, search, replacement, label, expectedMin = 1) => {
  const count = source.split(search).length - 1;

  if (count < expectedMin) {
    fail(`[${label}] expected at least ${expectedMin} matches, got ${count}`);
  }

  return source.split(search).join(replacement);
};

if (!fs.existsSync(file)) {
  fail(`[missing] ${path.relative(repoRoot, file)}`);
}

let source = fs.readFileSync(file, 'utf8');

if (source.includes('_bufferedTerminalWriteChunks')) {
  console.log('✅ Round 29 already applied');
  process.exit(0);
}

if (!source.includes("private _bufferedTerminalWrite = '';")) {
  fail('[guard] TerminalSession write buffer 结构不符合预期，请贴 src/terminal/session.ts 当前内容。');
}

source = replaceOnce(
  source,
  `  private _bufferedTerminalWrite = '';`,
  `  private readonly _bufferedTerminalWriteChunks: string[] = [];
  private _bufferedTerminalWriteLength = 0;`,
  'replace write buffer field',
);

source = replaceAllChecked(
  source,
  `this._bufferedTerminalWrite.length`,
  `this._bufferedTerminalWriteLength`,
  'replace write buffer length reads',
);

source = replaceAllChecked(
  source,
  `this._bufferedTerminalWrite = '';`,
  `this._clearTerminalWriteBuffer();`,
  'replace direct write buffer clear',
  2,
);

source = replaceOnce(
  source,
  `  // -- Private: write buffer -----------------------------------------------

  private _flushPendingTerminalWriteCallbacks(): void {`,
  `  // -- Private: write buffer -----------------------------------------------

  private _hasPendingTerminalWrite(): boolean {
    return this._bufferedTerminalWriteLength > 0;
  }

  private _appendTerminalWriteBuffer(value: string): void {
    if (!value) {
      return;
    }

    this._bufferedTerminalWriteChunks.push(value);
    this._bufferedTerminalWriteLength += value.length;
  }

  private _prependTerminalWriteBuffer(value: string): void {
    if (!value) {
      return;
    }

    this._bufferedTerminalWriteChunks.unshift(value);
    this._bufferedTerminalWriteLength += value.length;
  }

  private _drainTerminalWriteBuffer(): string {
    if (this._bufferedTerminalWriteLength === 0) {
      return '';
    }

    if (this._bufferedTerminalWriteChunks.length === 1) {
      const value = this._bufferedTerminalWriteChunks[0] ?? '';
      this._clearTerminalWriteBuffer();
      return value;
    }

    const value = this._bufferedTerminalWriteChunks.join('');
    this._clearTerminalWriteBuffer();
    return value;
  }

  private _clearTerminalWriteBuffer(): void {
    this._bufferedTerminalWriteChunks.length = 0;
    this._bufferedTerminalWriteLength = 0;
  }

  private _flushPendingTerminalWriteCallbacks(): void {`,
  'insert write buffer queue helpers',
);

source = replaceOnce(
  source,
  `    if (!this._visible) {
      if (this._bufferedTerminalWrite) {
        this._hiddenWriteBacklog.append(this._bufferedTerminalWrite);
        this._clearTerminalWriteBuffer();
      }
      if (this._pendingScrollToBottomAfterWrite) {`,
  `    if (!this._visible) {
      const bufferedWrite = this._drainTerminalWriteBuffer();

      if (bufferedWrite) {
        this._hiddenWriteBacklog.append(bufferedWrite);
      }

      if (this._pendingScrollToBottomAfterWrite) {`,
  'hidden write drain',
);

source = replaceOnce(
  source,
  `    if (!this._hiddenWriteBacklog.isEmpty) {
      this._bufferedTerminalWrite = \`\${this._hiddenWriteBacklog.drain()}\${this._bufferedTerminalWrite}\`;
      if (this._pendingHiddenScrollToBottom) {
        this._pendingScrollToBottomAfterWrite = true;
        this._pendingHiddenScrollToBottom = false;
      }
    }`,
  `    if (!this._hiddenWriteBacklog.isEmpty) {
      this._prependTerminalWriteBuffer(this._hiddenWriteBacklog.drain());

      if (this._pendingHiddenScrollToBottom) {
        this._pendingScrollToBottomAfterWrite = true;
        this._pendingHiddenScrollToBottom = false;
      }
    }`,
  'prepend hidden backlog',
);

source = replaceAllChecked(
  source,
  `if (!this._bufferedTerminalWrite)`,
  `if (!this._hasPendingTerminalWrite())`,
  'replace pending write false checks',
);

source = replaceOnce(
  source,
  `    const chunk = this._bufferedTerminalWrite;
    const shouldScroll = this._pendingScrollToBottomAfterWrite;
    this._clearTerminalWriteBuffer();`,
  `    const chunk = this._drainTerminalWriteBuffer();
    const shouldScroll = this._pendingScrollToBottomAfterWrite;`,
  'drain chunk before xterm write',
);

source = replaceAllChecked(
  source,
  `if (this._bufferedTerminalWrite)`,
  `if (this._hasPendingTerminalWrite())`,
  'replace pending write true checks',
);

source = replaceOnce(
  source,
  `    if (this._bufferedTerminalWrite || this._pendingTerminalWriteCallbacks.length > 0) {
      this._scheduleTerminalWriteFlush();
    }`,
  `    if (this._hasPendingTerminalWrite() || this._pendingTerminalWriteCallbacks.length > 0) {
      this._scheduleTerminalWriteFlush();
    }`,
  'settled pending write check',
);

source = replaceOnce(
  source,
  `    this._bufferedTerminalWrite += normalizedValue;`,
  `    this._appendTerminalWriteBuffer(normalizedValue);`,
  'append terminal write buffer',
);

fs.writeFileSync(file, source);

console.log('✅ Applied Round 29: terminal write buffer now uses chunk queue');
console.log(`📝 Updated: ${path.relative(repoRoot, file)}`);