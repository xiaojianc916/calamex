#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const filePath = 'src/services/editor/codemirror-shiki-highlight.ts';
const absolutePath = resolve(root, filePath);

const fail = (message) => {
  throw new Error(`[${filePath}] ${message}`);
};

let source = readFileSync(absolutePath, 'utf8');

const insertAfterOnce = (anchor, insertion, label) => {
  if (source.includes(insertion.trim())) {
    return;
  }

  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 anchor match, got ${count}`);
  }

  source = source.replace(anchor, `${anchor}${insertion}`);
};

const insertBeforeOnce = (anchor, insertion, label) => {
  if (source.includes(insertion.trim())) {
    return;
  }

  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 anchor match, got ${count}`);
  }

  source = source.replace(anchor, `${insertion}${anchor}`);
};

const replaceOnce = (oldText, newText, label) => {
  if (source.includes(newText.trim())) {
    return;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}: expected 1 match, got ${count}`);
  }

  source = source.replace(oldText, newText);
};

// 1. 增加 worker 请求类型。
//    TShikiHighlightRequestIdentity 只描述 identity，不带 code。
//    背压队列需要保存 code 和 view，用于稍后只执行最新请求。
insertAfterOnce(
  `type TShikiHighlightRequestIdentity = {
  key: string;
  requestId: number;
  docVersion: number;
  language: string;
  startLine: number;
  endLine: number;
};

`,
  `type TQueuedShikiWorkerRequest = {
  view: EditorView;
  code: string;
  requestId: number;
  docVersion: number;
  language: string;
  startLine: number;
  endLine: number;
};

`,
  'add queued worker request type',
);

// 2. 增加背压状态。
//    activeWorkerRequestId: 当前正在跑的主高亮 worker。
//    queuedWorkerRequest: 快速滚动时只保留最后一个待执行请求。
insertAfterOnce(
  `    private pendingRequest: TShikiHighlightRequestIdentity | null = null;
`,
  `    private activeWorkerRequestId: number | null = null;
    private queuedWorkerRequest: TQueuedShikiWorkerRequest | null = null;
`,
  'add worker backpressure fields',
);

// 3. destroy 时清理队列。
//    已经发到 worker 的任务无法真正 abort，但回包会被 destroyed/requestId 校验丢弃。
replaceOnce(
  `      this.pendingRequest = null;
      this.lineTokenCache.clear();`,
  `      this.pendingRequest = null;
      this.activeWorkerRequestId = null;
      this.queuedWorkerRequest = null;
      this.lineTokenCache.clear();`,
  'clear worker backpressure state on destroy',
);

// 兼容 round14：如果 destroy 里已经插入了 decoration cache 清理，上面的 exact replace 可能不会命中。
// 做一个更宽松的补丁。
if (!source.includes('this.queuedWorkerRequest = null;')) {
  replaceOnce(
    `      this.pendingRequest = null;
      this.lineTokenCache.clear();
      this.decorationCacheKey = null;
      this.decorationCache = null;`,
    `      this.pendingRequest = null;
      this.activeWorkerRequestId = null;
      this.queuedWorkerRequest = null;
      this.lineTokenCache.clear();
      this.decorationCacheKey = null;
      this.decorationCache = null;`,
    'clear worker backpressure state on destroy with decoration cache',
  );
}

// 4. 插入 worker 背压执行方法。
//    核心：
//    - 如果已有 worker 在跑，新请求只覆盖 queuedWorkerRequest。
//    - 当前 worker 跑完后，只执行队列里的最后一个请求。
//    - 队列请求执行前再次校验 requestId/docVersion/language，避免跑过期任务。
insertBeforeOnce(
  `    private takeWorkerResult(update: ViewUpdate): TShikiWorkerHighlightResult | null {
`,
  `    private enqueueWorkerTokenize(request: TQueuedShikiWorkerRequest): void {
      if (this.activeWorkerRequestId !== null) {
        this.queuedWorkerRequest = request;
        return;
      }

      this.runWorkerTokenize(request);
    }

    private runWorkerTokenize(request: TQueuedShikiWorkerRequest): void {
      this.activeWorkerRequestId = request.requestId;

      void tokenizeWithShikiWorker(request.code, request.language)
        .then((tokens) => {
          if (this.destroyed) {
            return;
          }

          try {
            request.view.dispatch({
              effects: shikiWorkerResultEffect.of({
                requestId: request.requestId,
                docVersion: request.docVersion,
                language: request.language,
                startLine: request.startLine,
                endLine: request.endLine,
                tokens,
              }),
            });
          } catch {
            // view 已销毁，忽略。
          }
        })
        .finally(() => {
          if (this.pendingRequest?.requestId === request.requestId) {
            this.pendingRequest = null;
          }

          if (this.activeWorkerRequestId === request.requestId) {
            this.activeWorkerRequestId = null;
          }

          const queued = this.queuedWorkerRequest;
          this.queuedWorkerRequest = null;

          if (!queued || this.destroyed) {
            return;
          }

          const currentLanguage = queued.view.state.field(shikiLanguageField, false) ?? 'text';
          const isStillLatest =
            queued.requestId === this.latestRequestId &&
            queued.docVersion === this.docVersion &&
            queued.language === currentLanguage;

          if (!isStillLatest) {
            return;
          }

          this.runWorkerTokenize(queued);
        });
    }

`,
  'add worker backpressure methods',
);

// 5. 替换 recompute 里的直接 worker 调用为背压队列。
//    旧逻辑每次快速滚动都会发 worker；新逻辑最多 1 个 active + 1 个 latest queued。
replaceOnce(
  `      void tokenizeWithShikiWorker(slice.code, language)
        .then((tokens) => {
          if (this.destroyed) {
            return;
          }
          try {
            view.dispatch({
              effects: shikiWorkerResultEffect.of({
                requestId,
                docVersion,
                language,
                startLine: slice.startLine,
                endLine: slice.endLine,
                tokens,
              }),
            });
          } catch {
            // view 已销毁，忽略。
          }
        })
        .finally(() => {
          if (this.pendingRequest?.requestId === requestId) {
            this.pendingRequest = null;
          }
        });`,
  `      this.enqueueWorkerTokenize({
        view,
        code: slice.code,
        requestId,
        docVersion,
        language,
        startLine: slice.startLine,
        endLine: slice.endLine,
      });`,
  'replace direct worker tokenize with backpressure queue',
);

writeFileSync(absolutePath, source, 'utf8');

console.log('Applied round16 editor worker backpressure optimization.');
console.log('');
console.log('Touched:');
console.log(` - ${filePath}`);
console.log('');
console.log('Why:');
console.log(' - Prevents fast scrolling from launching many obsolete Shiki worker tokenization jobs.');
console.log(' - Allows at most one active main highlight worker request and one latest queued request.');
console.log(' - Keeps requestId/docVersion/language guards, so stale worker results cannot affect the UI.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test src/services/editor/codemirror-shiki-highlight.spec.ts');
console.log('');
console.log('Experience check:');
console.log('  pnpm dev');
console.log('  Open a large file and fling-scroll repeatedly up/down.');
console.log('');
console.log('Rollback:');
console.log(`  git checkout -- ${filePath}`);