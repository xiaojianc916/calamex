// scripts/optimize-p0-chunked-highlight.mjs
// 用法:
//   node scripts/optimize-p0-chunked-highlight.mjs            # dry-run
//   node scripts/optimize-p0-chunked-highlight.mjs --write    # 落盘
//   node scripts/optimize-p0-chunked-highlight.mjs --revert --write  # 还原
//
// P0 第1层: Shiki 高亮「从文档首行起」切片的下沿按块对齐，消除向下滚动/打字时
// 对整段前缀的重复 tokenize。纯函数 + 可选参数，渲染与现有测试契约不变。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');
const REVERT = process.argv.includes('--revert');

const HL = 'src/services/editor/codemirror-shiki-highlight.ts';
const SPEC = 'src/services/editor/codemirror-shiki-highlight.spec.ts';

/** @type {{file:string,label:string,from:string,to:string}[]} */
const EDITS = [
  // 1) 新增块大小常量
  {
    file: HL,
    label: '新增 HIGHLIGHT_SLICE_CHUNK_LINES 常量',
    from: `const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;`,
    to: `const MAX_HIGHLIGHT_SLICE_LENGTH = 200_000;\n\n// 「从文档首行起」tokenize 切片下沿的块大小（行）。滚动/打字时把切片终点向上对齐到\n// 块边界，使相同区段的切片字符串稳定 → 命中 shiki-highlighter 的按串 token 缓存与按行\n// 缓存，把「向下滚动/打字时逐行重算整段前缀」从每行一次降到每跨一个块一次。512 行在\n// 常规代码下远低于 MAX_HIGHLIGHT_SLICE_LENGTH 体积上限。\nconst HIGHLIGHT_SLICE_CHUNK_LINES = 512;`,
  },
  // 2) computeShikiHighlightRange 增加可选 chunkLines（不传 = 旧行为）
  {
    file: HL,
    label: 'computeShikiHighlightRange 支持可选 chunkLines 量化',
    from: `  fromDocumentStart: boolean;\n  leadInLines?: number;\n}): { startLine: number; endLine: number } => {\n  const leadInLines = input.leadInLines ?? input.overscanLines;\n  const endLine = Math.min(input.totalLines, input.lastVisibleLine + input.overscanLines);\n  const startLine = input.fromDocumentStart ? 1 : Math.max(1, input.firstVisibleLine - leadInLines);\n  return { startLine, endLine };\n};`,
    to: `  fromDocumentStart: boolean;\n  leadInLines?: number;\n  // 可选：把下沿向上取整到该行数的整数倍（夹取到末行）。用于让「从文档首行起」的\n  // tokenize 切片在滚动时按块稳定；不传 = 不量化（渲染/覆盖判定等调用点行为不变）。\n  chunkLines?: number;\n}): { startLine: number; endLine: number } => {\n  const leadInLines = input.leadInLines ?? input.overscanLines;\n  const rawEndLine = Math.min(input.totalLines, input.lastVisibleLine + input.overscanLines);\n  const endLine =\n    input.chunkLines && input.chunkLines > 0\n      ? Math.min(input.totalLines, Math.ceil(rawEndLine / input.chunkLines) * input.chunkLines)\n      : rawEndLine;\n  const startLine = input.fromDocumentStart ? 1 : Math.max(1, input.firstVisibleLine - leadInLines);\n  return { startLine, endLine };\n};`,
  },
  // 3) 切片构建：仅 fromDocumentStart 路径量化下沿（窗口兜底保持紧贴视口）
  {
    file: HL,
    label: 'computeShikiHighlightSlice 在 fromDocumentStart 路径传入 chunkLines',
    from: `      overscanLines: HIGHLIGHT_OVERSCAN_LINES,\n      leadInLines: options.leadInLines ?? HIGHLIGHT_OVERSCAN_LINES,\n      fromDocumentStart,\n    });`,
    to: `      overscanLines: HIGHLIGHT_OVERSCAN_LINES,\n      leadInLines: options.leadInLines ?? HIGHLIGHT_OVERSCAN_LINES,\n      fromDocumentStart,\n      chunkLines: fromDocumentStart ? HIGHLIGHT_SLICE_CHUNK_LINES : undefined,\n    });`,
  },
  // 4) 追加针对量化的单测
  {
    file: SPEC,
    label: '追加 chunkLines 量化单测',
    from: `      }),\n    ).toEqual({ startLine: 1, endLine: 480 });\n  });\n});`,
    to: `      }),\n    ).toEqual({ startLine: 1, endLine: 480 });\n  });\n\n  it('chunkLines 把下沿向上取整到块边界（滚动时切片按块稳定）', () => {\n    // 380 + 40 = 420 → 向上取整到 512 的整数倍 = 512\n    expect(\n      computeShikiHighlightRange({\n        firstVisibleLine: 300,\n        lastVisibleLine: 380,\n        totalLines: 5000,\n        overscanLines: 40,\n        fromDocumentStart: true,\n        chunkLines: 512,\n      }),\n    ).toEqual({ startLine: 1, endLine: 512 });\n  });\n\n  it('chunkLines 量化后的下沿仍夹取到文档末行', () => {\n    // 980 + 40 = 1020 → 取整到 1024 → 夹取到 1000\n    expect(\n      computeShikiHighlightRange({\n        firstVisibleLine: 900,\n        lastVisibleLine: 980,\n        totalLines: 1000,\n        overscanLines: 40,\n        fromDocumentStart: true,\n        chunkLines: 512,\n      }),\n    ).toEqual({ startLine: 1, endLine: 1000 });\n  });\n\n  it('同一块内视口移动产生相同量化下沿（切片串稳定的前提）', () => {\n    const a = computeShikiHighlightRange({\n      firstVisibleLine: 10,\n      lastVisibleLine: 60,\n      totalLines: 5000,\n      overscanLines: 40,\n      fromDocumentStart: true,\n      chunkLines: 512,\n    });\n    const b = computeShikiHighlightRange({\n      firstVisibleLine: 80,\n      lastVisibleLine: 130,\n      totalLines: 5000,\n      overscanLines: 40,\n      fromDocumentStart: true,\n      chunkLines: 512,\n    });\n    expect(a.endLine).toBe(b.endLine);\n    expect(a.endLine).toBe(512);\n  });\n});`,
  },
];

const run = async () => {
  const byFile = new Map();
  for (const e of EDITS) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)).push(e);

  let applied = 0;
  for (const [file, edits] of byFile) {
    const path = resolve(ROOT, file);
    let text = await readFile(path, 'utf8');
    const original = text;
    for (const e of edits) {
      const find = REVERT ? e.to : e.from;
      const repl = REVERT ? e.from : e.to;
      if (text.includes(repl) && !text.includes(find)) {
        console.log(`⏭  已是目标状态，跳过: ${e.label}`);
        continue;
      }
      const count = text.split(find).length - 1;
      if (count !== 1) throw new Error(`✗ 锚点不唯一(${count}) 中止: ${e.label} @ ${file}`);
      text = text.replace(find, repl);
      applied += 1;
      console.log(`✓ ${e.label}`);
    }
    if (text !== original && WRITE) await writeFile(path, text, 'utf8');
  }
  console.log(`\n${WRITE ? '已写入' : 'DRY-RUN'} · 命中 ${applied} 处${REVERT ? '（还原模式）' : ''}`);
  if (!WRITE) console.log('加 --write 落盘；随后 pnpm lint && pnpm typecheck && pnpm test');
};

run().catch((e) => { console.error(e.message); process.exit(1); });