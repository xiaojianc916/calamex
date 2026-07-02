// 20-unify-shell-completion.mjs — 终端补全复用 bash-runtime 的共享 Language/Parser，摘除 tree-sitter-bash 依赖
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PATH = join(process.cwd(), "src/domains/terminal/utils/shell-completion.ts")
let content = readFileSync(PATH, "utf8")
let ok = true
const sub = (oldText, newText, label) => {
	if (content.includes(oldText)) {
		content = content.replace(oldText, newText)
	} else {
		ok = false
		console.log(`⚠️ 未命中: ${label}`)
	}
}

// 1) 三行 import → 改为类型 import + 复用 bash-runtime 共享加载器
sub(
	`import bashLanguageWasmUrl from 'tree-sitter-bash/tree-sitter-bash.wasm?url';
import { Edit, Language, type Node, Parser, type Point, type Tree } from 'web-tree-sitter';
import treeSitterWasmUrl from 'web-tree-sitter/web-tree-sitter.wasm?url';
import { listShellCommandLabels, loadShellCommandSpec } from '@/services/shell/command-catalog';`,
	`import { Edit, type Language, type Node, type Point, type Tree } from 'web-tree-sitter';
import {
  ensureBashLanguage,
  ensureBashParser,
} from '@/services/editor/tree-sitter/bash-runtime';
import { listShellCommandLabels, loadShellCommandSpec } from '@/services/shell/command-catalog';`,
	"import 头",
)

// 2) 删除本地 runtimePromise / parserPromise 两个模块级变量
sub(
	`let runtimePromise: Promise<Language> | null = null;
let parserPromise: Promise<Parser> | null = null;
let shellParseCache: IShellParseCacheEntry | null = null;`,
	`let shellParseCache: IShellParseCacheEntry | null = null;`,
	"模块级变量",
)

// 3) 删除本地 ensureTreeSitterLanguage / ensureParser 两段（复用 bash-runtime 的导出）
sub(
	`const ensureTreeSitterLanguage = async (): Promise<Language> => {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        await Parser.init({
          locateFile: () => treeSitterWasmUrl,
        });
        return await Language.load(bashLanguageWasmUrl);
      } catch (error) {
        runtimePromise = null;
        throw error;
      }
    })();
  }
  return runtimePromise;
};

// 复用单例 Parser：避免每次补全都 new/delete 一个 tree-sitter 解析器。
const ensureParser = async (): Promise<Parser> => {
  if (!parserPromise) {
    parserPromise = (async () => {
      try {
        const language = await ensureTreeSitterLanguage();
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      } catch (error) {
        parserPromise = null;
        throw error;
      }
    })();
  }
  return parserPromise;
};

`,
	``,
	"本地加载器定义",
)

// 4) parseShellDocument 内的调用改用共享导出
sub(
	`  const language = await ensureTreeSitterLanguage();
  const parser = await ensureParser();`,
	`  const language = await ensureBashLanguage();
  const parser = await ensureBashParser();`,
	"parseShellDocument 调用",
)

writeFileSync(PATH, content, "utf8")
console.log(ok ? "✅ shell-completion.ts 已统一到 bash-runtime 共享加载器" : "⚠️ 有锚点未命中，请把上面提示的部分发我")