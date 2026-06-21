// scripts/codemods/floating-search-border-shadow.mjs
// 浮动查找/转到弹窗:宽度更小、图标更小、边框=双层描边(#e7e6e4/#efefee)+8层1px阴影(#f7→#fe)
// 用法: node scripts/codemods/floating-search-border-shadow.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/editor/CodeMirrorScriptEditor.vue';
const src0 = readFileSync(FILE, 'utf8');

// 幂等:最外层 10px 阴影环已存在则跳过
if (src0.includes('0 0 0 10px #fefefe')) {
  console.log('[skip] 边框/阴影叠加已应用,无需重复。');
  process.exit(0);
}

let src = src0;
const replaceOnce = (from, to) => {
  const i = src.indexOf(from);
  if (i === -1) throw new Error(`锚点未找到:\n${from}`);
  if (src.indexOf(from, i + from.length) !== -1) throw new Error(`锚点不唯一:\n${from}`);
  src = src.slice(0, i) + to + src.slice(i + from.length);
};

// 1) JS 定位回退宽度常量 320 → 272(与 CSS 对齐)
replaceOnce('const SEARCH_POPUP_WIDTH = 320;', 'const SEARCH_POPUP_WIDTH = 272;');

// 2) 弹窗宽度 320 → 272
replaceOnce(
  '  width: 320px;\n  max-width: calc(100vw - 24px);',
  '  width: 272px;\n  max-width: calc(100vw - 24px);',
);

// 3) 边框/阴影:单层描边 → 双层描边 + 8 层 1px 阴影(圆角保持 12px)
replaceOnce(
  `  background: #ffffff;
  border: 1px solid #e6e8eb;
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12), 0 0 0 0.5px rgba(15, 23, 42, 0.04);`,
  `  background: #ffffff;
  border: none;
  border-radius: 12px;
  box-shadow:
    0 0 0 1px #e7e6e4,
    0 0 0 2px #efefee,
    0 0 0 3px #f7f7f7,
    0 0 0 4px #f8f8f8,
    0 0 0 5px #f9f9f9,
    0 0 0 6px #fafafa,
    0 0 0 7px #fbfbfb,
    0 0 0 8px #fcfcfc,
    0 0 0 9px #fdfdfd,
    0 0 0 10px #fefefe;`,
);

// 4) 拖拽手柄盒子 22 → 20
replaceOnce('  width: 22px;\n  height: 22px;', '  width: 20px;\n  height: 20px;');

// 5) 手柄图标 15 → 13
replaceOnce(
  `.cm-floating-search__grip svg {
  width: 15px;
  height: 15px;
}`,
  `.cm-floating-search__grip svg {
  width: 13px;
  height: 13px;
}`,
);

// 6) 图标按钮盒子 26 → 22,圆角 7 → 6
replaceOnce(
  `  width: 26px;
  height: 26px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 7px;`,
  `  width: 22px;
  height: 22px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  border-radius: 6px;`,
);

// 7) 按钮图标 16 → 14
replaceOnce(
  `.cm-floating-search__btn svg {
  width: 16px;
  height: 16px;
}`,
  `.cm-floating-search__btn svg {
  width: 14px;
  height: 14px;
}`,
);

writeFileSync(FILE, src, 'utf8');
console.log('[done] 已更新:宽度272 / 图标缩小 / 双层描边+8层阴影。');