// 3-update-registry.mjs — 重写 language-registry.generated.ts，全部改用本地自编译 wasm + 新拉取的 queries
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const OUT = join(process.cwd(), "src/services/editor/tree-sitter/language-registry.generated.ts")

const content = `// 本文件由脚本生成，请勿手改。
// wasm 为本地自编译产物（tree-sitter build --wasm，见 grammars.lock.json）；highlights.scm 来自各语法官方仓库（保留其 OSS 许可）。
import shell_wasm from './wasm/tree-sitter-bash.wasm?url';
import c_wasm from './wasm/tree-sitter-c.wasm?url';
import csharp_wasm from './wasm/tree-sitter-c-sharp.wasm?url';
import cpp_wasm from './wasm/tree-sitter-cpp.wasm?url';
import css_wasm from './wasm/tree-sitter-css.wasm?url';
import go_wasm from './wasm/tree-sitter-go.wasm?url';
import html_wasm from './wasm/tree-sitter-html.wasm?url';
import java_wasm from './wasm/tree-sitter-java.wasm?url';
import javascript_wasm from './wasm/tree-sitter-javascript.wasm?url';
import jsx_wasm from './wasm/tree-sitter-javascript.wasm?url';
import json_wasm from './wasm/tree-sitter-json.wasm?url';
import kotlin_wasm from './wasm/tree-sitter-kotlin.wasm?url';
import lua_wasm from './wasm/tree-sitter-lua.wasm?url';
import python_wasm from './wasm/tree-sitter-python.wasm?url';
import ruby_wasm from './wasm/tree-sitter-ruby.wasm?url';
import rust_wasm from './wasm/tree-sitter-rust.wasm?url';
import scala_wasm from './wasm/tree-sitter-scala.wasm?url';
import swift_wasm from './wasm/tree-sitter-swift.wasm?url';
import toml_wasm from './wasm/tree-sitter-toml.wasm?url';
import tsx_wasm from './wasm/tree-sitter-tsx.wasm?url';
import typescript_wasm from './wasm/tree-sitter-typescript.wasm?url';
import yaml_wasm from './wasm/tree-sitter-yaml.wasm?url';
import dart_wasm from './wasm/tree-sitter-dart.wasm?url';
import diff_wasm from './wasm/tree-sitter-diff.wasm?url';
import dockerfile_wasm from './wasm/tree-sitter-dockerfile.wasm?url';
import markdown_wasm from './wasm/tree-sitter-markdown.wasm?url';
// vue 暂不支持：上游 ikatyang/tree-sitter-vue 的外部扫描器与新版 wasm 构建不兼容，保留旧引用（已知不可用，不影响其他语言）。
import vue_wasm from 'tree-sitter-wasms/out/tree-sitter-vue.wasm?url';

import c_scm from './queries/c/highlights.scm?raw';
import cpp_scm from './queries/cpp/highlights.scm?raw';
import csharp_scm from './queries/c-sharp/highlights.scm?raw';
import css_scm from './queries/css/highlights.scm?raw';
import go_scm from './queries/go/highlights.scm?raw';
import html_scm from './queries/html/highlights.scm?raw';
import java_scm from './queries/java/highlights.scm?raw';
import javascript_scm from './queries/javascript/highlights.scm?raw';
import json_scm from './queries/json/highlights.scm?raw';
import jsx_scm from './queries/jsx/highlights.scm?raw';
import kotlin_scm from './queries/kotlin/highlights.scm?raw';
import lua_scm from './queries/lua/highlights.scm?raw';
import python_scm from './queries/python/highlights.scm?raw';
import ruby_scm from './queries/ruby/highlights.scm?raw';
import rust_scm from './queries/rust/highlights.scm?raw';
import scala_scm from './queries/scala/highlights.scm?raw';
import shell_scm from './queries/shell/highlights.scm?raw';
import swift_scm from './queries/swift/highlights.scm?raw';
import toml_scm from './queries/toml/highlights.scm?raw';
import tsx_scm from './queries/tsx/highlights.scm?raw';
import typescript_scm from './queries/typescript/highlights.scm?raw';
import yaml_scm from './queries/yaml/highlights.scm?raw';
import dart_scm from './queries/dart/highlights.scm?raw';
import diff_scm from './queries/diff/highlights.scm?raw';
import dockerfile_scm from './queries/dockerfile/highlights.scm?raw';
import markdown_scm from './queries/markdown/highlights.scm?raw';
import vue_scm from './queries/vue/highlights.scm?raw';

export interface ITreeSitterLanguageEntry {
	readonly wasmUrl: string;
	readonly scm: string;
}

export const TREE_SITTER_LANGUAGES: Readonly<Record<string, ITreeSitterLanguageEntry>> = {
	shell: { wasmUrl: shell_wasm, scm: shell_scm },
	javascript: { wasmUrl: javascript_wasm, scm: javascript_scm },
	jsx: { wasmUrl: jsx_wasm, scm: jsx_scm },
	typescript: { wasmUrl: typescript_wasm, scm: typescript_scm },
	tsx: { wasmUrl: tsx_wasm, scm: tsx_scm },
	python: { wasmUrl: python_wasm, scm: python_scm },
	rust: { wasmUrl: rust_wasm, scm: rust_scm },
	go: { wasmUrl: go_wasm, scm: go_scm },
	c: { wasmUrl: c_wasm, scm: c_scm },
	cpp: { wasmUrl: cpp_wasm, scm: cpp_scm },
	java: { wasmUrl: java_wasm, scm: java_scm },
	json: { wasmUrl: json_wasm, scm: json_scm },
	html: { wasmUrl: html_wasm, scm: html_scm },
	css: { wasmUrl: css_wasm, scm: css_scm },
	ruby: { wasmUrl: ruby_wasm, scm: ruby_scm },
	yaml: { wasmUrl: yaml_wasm, scm: yaml_scm },
	toml: { wasmUrl: toml_wasm, scm: toml_scm },
	lua: { wasmUrl: lua_wasm, scm: lua_scm },
	csharp: { wasmUrl: csharp_wasm, scm: csharp_scm },
	kotlin: { wasmUrl: kotlin_wasm, scm: kotlin_scm },
	scala: { wasmUrl: scala_wasm, scm: scala_scm },
	swift: { wasmUrl: swift_wasm, scm: swift_scm },
	dart: { wasmUrl: dart_wasm, scm: dart_scm },
	diff: { wasmUrl: diff_wasm, scm: diff_scm },
	dockerfile: { wasmUrl: dockerfile_wasm, scm: dockerfile_scm },
	markdown: { wasmUrl: markdown_wasm, scm: markdown_scm },
	vue: { wasmUrl: vue_wasm, scm: vue_scm },
};

const TS_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
	bash: 'shell',
	sh: 'shell',
	zsh: 'shell',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	py: 'python',
	rs: 'rust',
	h: 'c',
	cc: 'cpp',
	cxx: 'cpp',
	hpp: 'cpp',
	jsonc: 'json',
	htm: 'html',
	rb: 'ruby',
	yml: 'yaml',
	cs: 'csharp',
	kt: 'kotlin',
	kts: 'kotlin',
	docker: 'dockerfile',
	md: 'markdown',
	patch: 'diff',
};

/** 原始语言标签 -> tree-sitter 语言 id；无覆盖时返回 null。 */
export function resolveTreeSitterLanguageId(language: string): string | null {
	const tag = language.trim().toLowerCase();
	if (Object.hasOwn(TREE_SITTER_LANGUAGES, tag)) {
		return tag;
	}
	return TS_LANGUAGE_ALIASES[tag] ?? null;
}
`

writeFileSync(OUT, content, "utf8")
console.log(`已写入: ${OUT}`)