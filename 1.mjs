#!/usr/bin/env node
// wire-shell-highlight.mjs — 把自编译的 tree-sitter-bash.wasm 接入编辑器着色，端到端验证。
// 幂等、唯一锚点。用法：node wire-shell-highlight.mjs [--dry-run]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DRY = process.argv.includes('--dry-run');
const ROOT = process.cwd();
const write = (p, s) => { if (!DRY) writeFileSync(p, s, 'utf8'); };
const replace = (file, label, from, to) => {
  let src = readFileSync(file, 'utf8');
  const n = src.split(from).length - 1;
  if (n === 0) { console.log(`  [跳过] ${label}（锚点未命中 → 可能已修或已改动，人工确认）`); return; }
  if (n > 1) throw new Error(`锚点不唯一(${n}处): ${label}`);
  write(file, src.replace(from, to));
  if (!DRY) console.log(`  ✔ ${label}`);
};

// ── 1. 建 wasm 目录，把编译好的 bash wasm 放进去 ───────────────────────────
const wasmDir = join(ROOT, 'src/services/editor/tree-sitter/wasm');
if (!DRY) mkdirSync(wasmDir, { recursive: true });

const compiled = join(ROOT, 'tree-sitter-bash.wasm');       // build --wasm 默认输出到 cwd
const dest     = join(wasmDir, 'tree-sitter-bash.wasm');

if (!existsSync(compiled)) {
  console.error('❌ 未找到 tree-sitter-bash.wasm（在项目根目录找）。先跑：tree-sitter build --wasm node_modules/tree-sitter-bash');
  process.exit(1);
}
if (!DRY) copyFileSync(compiled, dest);
console.log(`1. ${DRY ? '[dry] ' : ''}复制 → src/services/editor/tree-sitter/wasm/tree-sitter-bash.wasm`);

// ── 2. 更新 registry：shell 条目改用本地自编译 wasm ────────────────────────
const REGISTRY = join(ROOT, 'src/services/editor/tree-sitter/language-registry.generated.ts');
console.log('2. 更新 registry shell 条目:');
replace(REGISTRY, 'shell wasm 来源',
  `import shell_wasm from 'tree-sitter-wasms/out/tree-sitter-bash.wasm?url';`,
  `import shell_wasm from './wasm/tree-sitter-bash.wasm?url';`);

// ── 3. 修复 applyLanguageExtension 接线（该用 loadCodeMirrorLanguageExtension）──
const VUE = join(ROOT, 'src/components/editor/CodeMirrorScriptEditor.vue');
console.log('3. 修复 applyLanguageExtension 接线:');

// 3a. import 换成带 tree-sitter 包裹的加载函数
const vueAlreadyFixed = readFileSync(VUE, 'utf8').includes('loadCodeMirrorLanguageExtension(language).then');
if (vueAlreadyFixed) {
  console.log('  [跳过] applyLanguageExtension 已修过');
} else {
  replace(VUE, 'import codemirror-language',
    `import {\n  loadCodeMirrorLanguageSupport,\n  resolveCodeMirrorLanguageExtension,\n} from '@/services/editor/codemirror-language';`,
    `import {\n  loadCodeMirrorLanguageExtension,\n  resolveCodeMirrorLanguageExtension,\n} from '@/services/editor/codemirror-language';`);

  replace(VUE, 'applyLanguageExtension 函数体',
    `const applyLanguageExtension = (language: string): void => {\n  void loadCodeMirrorLanguageSupport(language).then((support) => {\n    const view = editorView;\n    // 加载期间文档可能已切换语言，过期结果直接丢弃。\n    if (!view || getCurrentLanguage() !== language) return;\n    view.dispatch({ effects: languageCompartment.reconfigure(support ?? []) });\n  });\n};`,
    `const applyLanguageExtension = (language: string): void => {\n  // 必须用 loadCodeMirrorLanguageExtension（内含 withTreeSitterHighlight）而非裸的\n  // loadCodeMirrorLanguageSupport，否则异步加载完成后 tree-sitter 着色会被覆盖掉。\n  void loadCodeMirrorLanguageExtension(language).then((extension) => {\n    const view = editorView;\n    // 加载期间文档可能已切换语言，过期结果直接丢弃。\n    if (!view || getCurrentLanguage() !== language) return;\n    view.dispatch({ effects: languageCompartment.reconfigure(extension) });\n  });\n};`);
}

// ── 4. .gitignore 追加 wasm 目录（编译产物不入库）─────────────────────────
const GITIGNORE = join(ROOT, '.gitignore');
const giContent = readFileSync(GITIGNORE, 'utf8');
const wasmIgnoreLine = 'src/services/editor/tree-sitter/wasm/';
if (!giContent.includes(wasmIgnoreLine)) {
  if (!DRY) appendFileSync(GITIGNORE, `\n# tree-sitter 自编译语法 wasm（provision 产物，不入库）\n${wasmIgnoreLine}\n`);
  console.log('4. .gitignore 追加 wasm 目录');
} else {
  console.log('4. [跳过] .gitignore 已有该条目');
}

console.log(DRY ? '\n[dry-run 完成] 未写盘。' : '\n✅ 完成。重启 dev，打开一个 .sh 文件，shell 应有语法高亮。');