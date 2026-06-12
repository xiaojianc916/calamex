#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write = (path, text) => writeFileSync(resolve(root, path), text, 'utf8');

const fail = (path, message) => {
  throw new Error(`[${path}] ${message}`);
};

const replaceOnce = (path, oldText, newText, label) => {
  const text = read(path);
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    fail(path, `${label}: expected 1 match, got ${count}`);
  }
  write(path, text.replace(oldText, newText));
};

const insertAfterOnce = (path, anchor, insertion, label) => {
  const text = read(path);
  if (text.includes(insertion.trim())) return;
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    fail(path, `${label}: expected 1 anchor match, got ${count}`);
  }
  write(path, text.replace(anchor, `${anchor}${insertion}`));
};

// ─────────────────────────────────────────────────────────────
// 1. IPC 类型：支持 measureOutput。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/services/tauri.ipc-types.ts';

  insertAfterOnce(
    path,
    `  measureInput?: (input: z.output<TInSchema>) => IPayloadMetrics;
`,
    `  measureOutput?: (output: z.output<TOutSchema>) => IPayloadMetrics;
`,
    'add defineIpc measureOutput type',
  );

  insertAfterOnce(
    path,
    `  measureInput?: (input: Record<string, unknown>) => IPayloadMetrics;
`,
    `  measureOutput?: (output: unknown) => IPayloadMetrics;
`,
    'add specta measureOutput type',
  );
}

// ─────────────────────────────────────────────────────────────
// 2. IPC runtime：输出度量优先走 measureOutput，避免大对象 JSON.stringify。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/services/tauri.ipc-runtime.ts';

  replaceOnce(
    path,
    `      if (shouldAudit) {
        reportOutputBytes(buildPayloadMetrics(output).bytes);
      }`,
    `      if (shouldAudit) {
        const outputMetrics = options.measureOutput
          ? options.measureOutput(output)
          : buildPayloadMetrics(output);
        reportOutputBytes(outputMetrics.bytes);
      }`,
    'use custom output metrics for specta command',
  );
}

// ─────────────────────────────────────────────────────────────
// 3. IPC factory：defineIpc 同样支持 measureOutput。
//    这不是当前 Git 必需，但保持 IPC 抽象一致，后续搜索/AI 大 payload 也能复用。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/services/tauri.ipc-factory.ts';

  replaceOnce(
    path,
    `        if (shouldAudit) {
          reportOutputBytes(buildPayloadMetrics(rawOutput).bytes);
        }

        return parsedOutput.data;`,
    `        if (shouldAudit) {
          const outputMetrics = options.measureOutput
            ? options.measureOutput(parsedOutput.data)
            : buildPayloadMetrics(rawOutput);
          reportOutputBytes(outputMetrics.bytes);
        }

        return parsedOutput.data;`,
    'use custom output metrics for contract ipc',
  );
}

// ─────────────────────────────────────────────────────────────
// 4. Git Tauri service：给大 payload 命令配置轻量 output metrics。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/services/tauri.git.ts';

  replaceOnce(
    path,
    `import { callSpectaCommand } from './tauri.ipc-runtime';`,
    `import { buildPayloadMetrics } from './tauri.ipc-metrics';
import { callSpectaCommand } from './tauri.ipc-runtime';`,
    'import buildPayloadMetrics',
  );

  insertAfterOnce(
    path,
    `import type { IIpcCallOptions } from './tauri.ipc-types';
`,
    `
const textByteLength = (value: unknown): number => {
  if (typeof value !== 'string' || value.length === 0) return 0;
  return typeof TextEncoder !== 'undefined'
    ? new TextEncoder().encode(value).length
    : value.length;
};

const shallowStringBytes = (value: unknown): number => {
  if (!value || typeof value !== 'object') return textByteLength(value);
  let total = 0;
  for (const fieldValue of Object.values(value as Record<string, unknown>)) {
    if (typeof fieldValue === 'string') {
      total += textByteLength(fieldValue);
    } else if (typeof fieldValue === 'number' || typeof fieldValue === 'boolean') {
      total += 8;
    }
  }
  return total;
};

const measureGitCommitDetailOutput = (output: unknown) => {
  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);

  const payload = output as {
    files?: Array<Record<string, unknown>>;
    body?: string;
    summary?: string;
    authorName?: string;
    authorEmail?: string;
    authoredAt?: string;
    id?: string;
    shortId?: string;
  };

  const baseBytes =
    textByteLength(payload.id) +
    textByteLength(payload.shortId) +
    textByteLength(payload.summary) +
    textByteLength(payload.body) +
    textByteLength(payload.authorName) +
    textByteLength(payload.authorEmail) +
    textByteLength(payload.authoredAt);

  const filesBytes = Array.isArray(payload.files)
    ? payload.files.reduce((total, file) => total + shallowStringBytes(file) + 24, 0)
    : 0;

  return { bytes: baseBytes + filesBytes + 96 };
};

const measureGitDiffPayloadOutput = (output: unknown) => {
  if (!output || typeof output !== 'object') return buildPayloadMetrics(output);

  const payload = output as {
    originalContent?: string;
    modifiedContent?: string;
    relativePath?: string;
    fileName?: string;
    title?: string;
    mode?: string;
    id?: string;
    repositoryRootPath?: string;
    path?: string;
    hunks?: Array<{
      lines?: Array<{ content?: string; tag?: string; oldLine?: number | null; newLine?: number | null }>;
    }>;
  };

  let bytes =
    textByteLength(payload.id) +
    textByteLength(payload.repositoryRootPath) +
    textByteLength(payload.path) +
    textByteLength(payload.relativePath) +
    textByteLength(payload.fileName) +
    textByteLength(payload.title) +
    textByteLength(payload.mode) +
    textByteLength(payload.originalContent) +
    textByteLength(payload.modifiedContent) +
    96;

  if (Array.isArray(payload.hunks)) {
    for (const hunk of payload.hunks) {
      bytes += 32;
      if (!Array.isArray(hunk.lines)) continue;
      for (const line of hunk.lines) {
        bytes += textByteLength(line.content) + textByteLength(line.tag) + 16;
      }
    }
  }

  return { bytes };
};

`,
    'insert git ipc metrics helpers',
  );

  replaceOnce(
    path,
    `        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitCommitDetail(payload),`,
    `        input: payload,
        signal: options?.signal,
        measureOutput: measureGitCommitDetailOutput,
      },
      () => commands.getGitCommitDetail(payload),`,
    'measure getGitCommitDetail output cheaply',
  );

  replaceOnce(
    path,
    `        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitCommitFileDiff(payload),`,
    `        input: payload,
        signal: options?.signal,
        measureOutput: measureGitDiffPayloadOutput,
      },
      () => commands.getGitCommitFileDiff(payload),`,
    'measure getGitCommitFileDiff output cheaply',
  );

  replaceOnce(
    path,
    `        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitCommitFileDiffPreview(payload),`,
    `        input: payload,
        signal: options?.signal,
        measureOutput: measureGitDiffPayloadOutput,
      },
      () => commands.getGitCommitFileDiffPreview(payload),`,
    'measure getGitCommitFileDiffPreview output cheaply',
  );

  replaceOnce(
    path,
    `        input: payload,
        signal: options?.signal,
      },
      () => commands.getGitDiffPreview(payload),`,
    `        input: payload,
        signal: options?.signal,
        measureOutput: measureGitDiffPayloadOutput,
      },
      () => commands.getGitDiffPreview(payload),`,
    'measure getGitDiffPreview output cheaply',
  );
}

console.log('Applied round6 IPC output metrics optimization.');
console.log('');
console.log('Touched:');
console.log(' - src/services/tauri.ipc-types.ts');
console.log(' - src/services/tauri.ipc-runtime.ts');
console.log(' - src/services/tauri.ipc-factory.ts');
console.log(' - src/services/tauri.git.ts');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Rollback:');
console.log('  git checkout -- src/services/tauri.ipc-types.ts src/services/tauri.ipc-runtime.ts src/services/tauri.ipc-factory.ts src/services/tauri.git.ts');