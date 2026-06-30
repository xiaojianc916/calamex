// 方案B 增强 · 收尾补丁（插件 3/4 + 静态高亮 4/4）
// 用法：仓库根目录执行  node 方案B-收尾.mjs
// 前置：worker / highlighter 已在 main —— 先 git pull 再运行本脚本。
// 仅改两份文件，内存内改完再落盘；任一锚点异常即抛错、不写文件。备份后缀 .b2.bak。

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const E = (p) => resolve(ROOT, p);
const PLUGIN = E('src/services/editor/codemirror-shiki-highlight.ts');
const STATIC = E('src/services/editor/codemirror-static-highlight.ts');

const read = (file) => {
  if (!existsSync(file)) throw new Error(`文件不存在: ${file}（请在仓库根目录运行）`);
  return readFileSync(file, 'utf8');
};
const backup = (file) => {
  const bak = `${file}.b2.bak`;
  if (!existsSync(bak)) copyFileSync(file, bak);
};
const once = (s, oldStr, newStr, label) => {
  const n = s.split(oldStr).length - 1;
  if (n === 0) throw new Error(`[${label}] 未找到锚点`);
  if (n > 1) throw new Error(`[${label}] 锚点不唯一（${n} 处）`);
  return s.replace(oldStr, newStr);
};
const all = (s, oldStr, newStr, label) => {
  const n = s.split(oldStr).length - 1;
  if (n === 0) throw new Error(`[${label}] 未找到锚点`);
  return s.split(oldStr).join(newStr);
};
const removeBetween = (s, startA, endA, label) => {
  const sc = s.split(startA).length - 1;
  if (sc !== 1) throw new Error(`[${label}] 起始锚点应唯一（实际 ${sc}）`);
  const i = s.indexOf(startA);
  const j = s.indexOf(endA, i + startA.length);
  if (j < 0) throw new Error(`[${label}] 未找到结束锚点`);
  return s.slice(0, i) + s.slice(j);
};

// ============ 插件文件 ============
function patchPlugin() {
  let c = read(PLUGIN);
  if (c.includes('private sendShikiEdit(')) {
    console.log('• 插件已是新版（含 sendShikiEdit），跳过');
    return;
  }
  backup(PLUGIN);

  // P1 import
  c = once(
    c,
    `import { tokenizeRangeWithShikiWorker } from '@/services/editor/shiki-highlighter';`,
    `import {
  applyShikiEdit,
  disposeShikiSession,
  tokenizeRangeWithShikiWorker,
} from '@/services/editor/shiki-highlighter';`,
    'P1 import',
  );

  // P2 移除 3 个切片常量及其注释
  c = removeBetween(
    c,
    `// 单次 tokenize 切片的字节上限：Worker 路径默认从文档开头切到可见区下沿，超过`,
    `// 可见区下方额外着色的行数：平滑滚动时的下方衔接缓冲。取较大值以覆盖快速滚动`,
    'P2 常量',
  );

  // P3 移除 TShikiHighlightSlice 类型
  c = removeBetween(c, `type TShikiHighlightSlice = {`, `type TShikiWorkerHighlightResult = {`, 'P3 类型');

  // P4 移除 computeShikiHighlightSlice 函数
  c = removeBetween(
    c,
    `/**
 * 截取需要 tokenize 的切片，单次成本与可见行数相关而非文档总长。`,
    `/**
 * 从按行 token 缓存构建 [startLine, endLine] 区间的装饰集合。`,
    'P4 函数',
  );

  // P5c 更新注释
  c = once(
    c,
    `      // 先用现有缓存（可能为部分命中）同步重建，已着色的行保持不变、不清空、不露白；再从
      // 文档开头切片交给 Worker，保证跨行结构配色正确，回包后入缓存重建。`,
    `      // 先用现有缓存（可能为部分命中）同步重建，已着色的行保持不变；再请求 Worker 对未命中的
      // 行范围 tokenize（Worker 持有整篇文档，按会话 + 行范围续算，无需主线程切片传整段代码）。`,
    'P5c 注释',
  );

  // P5a 切片获取 → 直接用 uncached 行范围 + 文档长度做缓存键
  c = once(
    c,
    `      const slice = computeShikiHighlightSlice(view, { fromDocumentStart: false });
      if (!slice) {
        return;
      }

      const docVersion = this.docVersion;
      const requestKey = createShikiHighlightRequestKey({
        language,
        docVersion,
        startLine: slice.startLine,
        endLine: slice.endLine,
        codeLength: slice.code.length,
      });`,
    `      const docVersion = this.docVersion;
      const requestKey = createShikiHighlightRequestKey({
        language,
        docVersion,
        startLine: uncached.startLine,
        endLine: uncached.endLine,
        codeLength: view.state.doc.length,
      });`,
    'P5a 请求构造',
  );

  // P5b 余下 slice.* → uncached.*
  c = all(c, `slice.startLine`, `uncached.startLine`, 'P5b startLine');
  c = all(c, `slice.endLine`, `uncached.endLine`, 'P5b endLine');

  // P6 docChanged 派发增量编辑
  c = once(
    c,
    `      if (update.docChanged) {
        this.docVersion += 1;
      }`,
    `      if (update.docChanged) {
        this.docVersion += 1;
        this.sendShikiEdit(update);
      }`,
    'P6 docChanged',
  );

  // P7 新增 sendShikiEdit 方法（插在 recompute 之前）
  const SEND = `    /**
     * 文档变更后向 Worker 发送行级增量 delta：fromLine..oldEndLine（旧文档）被替换为
     * fromLine..newEndLine（新文档）的行文本；Worker 据此原地更新整篇文本并仅作废受影响块状态。
     */
    private sendShikiEdit(update: ViewUpdate): void {
      const language = update.state.field(shikiLanguageField, false) ?? 'text';
      if (!resolveShikiLanguageId(language)) {
        return;
      }
      const oldDoc = update.startState.doc;
      const newDoc = update.state.doc;
      let minFromA = Number.POSITIVE_INFINITY;
      let maxToA = -1;
      let maxToB = -1;
      update.changes.iterChanges((fromA, toA, _fromB, toB) => {
        if (fromA < minFromA) {
          minFromA = fromA;
        }
        if (toA > maxToA) {
          maxToA = toA;
        }
        if (toB > maxToB) {
          maxToB = toB;
        }
      });
      if (maxToA < 0) {
        return;
      }
      const fromLine = oldDoc.lineAt(minFromA).number;
      const oldEndLine = oldDoc.lineAt(maxToA).number;
      const newEndLine = newDoc.lineAt(maxToB).number;
      const deletedLineCount = oldEndLine - fromLine + 1;
      const insertedLines: string[] = [];
      for (let ln = fromLine; ln <= newEndLine; ln += 1) {
        insertedLines.push(newDoc.line(ln).text);
      }
      applyShikiEdit(
        this.shikiSessionKey,
        this.docVersion,
        fromLine,
        deletedLineCount,
        insertedLines,
      );
    }`;
  c = once(
    c,
    `    private recompute(view: EditorView, options: { allowReuse: boolean }): void {`,
    `${SEND}

    private recompute(view: EditorView, options: { allowReuse: boolean }): void {`,
    'P7 sendShikiEdit',
  );

  // P8 destroy 释放会话
  c = once(
    c,
    `      this.cancelScheduledRecompute();
      this.pendingRequest = null;`,
    `      this.cancelScheduledRecompute();
      disposeShikiSession(this.shikiSessionKey);
      this.pendingRequest = null;`,
    'P8 destroy',
  );

  writeFileSync(PLUGIN, c, 'utf8');
  console.log('✓ 插件文件已更新');
}

// ============ 静态高亮文件 ============
function patchStatic() {
  let c = read(STATIC);
  if (c.includes('tokenizeSnippetWithShikiWorker')) {
    console.log('• 静态高亮已是新版，跳过');
    return;
  }
  backup(STATIC);
  c = once(c, `  tokenizeWithShikiWorker,`, `  tokenizeSnippetWithShikiWorker,`, 'S1 import');
  c = once(
    c,
    `const lines = await tokenizeWithShikiWorker(code, language);`,
    `const lines = await tokenizeSnippetWithShikiWorker(code, language);`,
    'S2 调用',
  );
  writeFileSync(STATIC, c, 'utf8');
  console.log('✓ 静态高亮文件已更新');
}

patchPlugin();
patchStatic();
console.log('\n全部完成。回滚：还原 *.b2.bak。');