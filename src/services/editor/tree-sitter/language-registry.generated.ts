// @generated 由 setup-tree-sitter-highlight.mjs 生成，请勿手改。
// wasm: tree-sitter-wasms（预编译语法）；scm: nvim-treesitter（MIT，标准 capture）。

import shell_wasm from 'tree-sitter-wasms/out/tree-sitter-bash.wasm?url';
import c_wasm from 'tree-sitter-wasms/out/tree-sitter-c.wasm?url';
import csharp_wasm from 'tree-sitter-wasms/out/tree-sitter-c_sharp.wasm?url';
import cpp_wasm from 'tree-sitter-wasms/out/tree-sitter-cpp.wasm?url';
import css_wasm from 'tree-sitter-wasms/out/tree-sitter-css.wasm?url';
import go_wasm from 'tree-sitter-wasms/out/tree-sitter-go.wasm?url';
import html_wasm from 'tree-sitter-wasms/out/tree-sitter-html.wasm?url';
import java_wasm from 'tree-sitter-wasms/out/tree-sitter-java.wasm?url';
import javascript_wasm from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm?url';
import jsx_wasm from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm?url';
import json_wasm from 'tree-sitter-wasms/out/tree-sitter-json.wasm?url';
import kotlin_wasm from 'tree-sitter-wasms/out/tree-sitter-kotlin.wasm?url';
import lua_wasm from 'tree-sitter-wasms/out/tree-sitter-lua.wasm?url';
import php_wasm from 'tree-sitter-wasms/out/tree-sitter-php.wasm?url';
import python_wasm from 'tree-sitter-wasms/out/tree-sitter-python.wasm?url';
import ruby_wasm from 'tree-sitter-wasms/out/tree-sitter-ruby.wasm?url';
import rust_wasm from 'tree-sitter-wasms/out/tree-sitter-rust.wasm?url';
import scala_wasm from 'tree-sitter-wasms/out/tree-sitter-scala.wasm?url';
import swift_wasm from 'tree-sitter-wasms/out/tree-sitter-swift.wasm?url';
import toml_wasm from 'tree-sitter-wasms/out/tree-sitter-toml.wasm?url';
import tsx_wasm from 'tree-sitter-wasms/out/tree-sitter-tsx.wasm?url';
import typescript_wasm from 'tree-sitter-wasms/out/tree-sitter-typescript.wasm?url';
import vue_wasm from 'tree-sitter-wasms/out/tree-sitter-vue.wasm?url';
import yaml_wasm from 'tree-sitter-wasms/out/tree-sitter-yaml.wasm?url';
import c_scm from './queries/c/highlights.scm?raw';
import cpp_scm from './queries/cpp/highlights.scm?raw';
import csharp_scm from './queries/csharp/highlights.scm?raw';
import css_scm from './queries/css/highlights.scm?raw';
import go_scm from './queries/go/highlights.scm?raw';
import html_scm from './queries/html/highlights.scm?raw';
import java_scm from './queries/java/highlights.scm?raw';
import javascript_scm from './queries/javascript/highlights.scm?raw';
import json_scm from './queries/json/highlights.scm?raw';
import jsx_scm from './queries/jsx/highlights.scm?raw';
import kotlin_scm from './queries/kotlin/highlights.scm?raw';
import lua_scm from './queries/lua/highlights.scm?raw';
import php_scm from './queries/php/highlights.scm?raw';
import python_scm from './queries/python/highlights.scm?raw';
import ruby_scm from './queries/ruby/highlights.scm?raw';
import rust_scm from './queries/rust/highlights.scm?raw';
import scala_scm from './queries/scala/highlights.scm?raw';
import shell_scm from './queries/shell/highlights.scm?raw';
import swift_scm from './queries/swift/highlights.scm?raw';
import toml_scm from './queries/toml/highlights.scm?raw';
import tsx_scm from './queries/tsx/highlights.scm?raw';
import typescript_scm from './queries/typescript/highlights.scm?raw';
import vue_scm from './queries/vue/highlights.scm?raw';
import yaml_scm from './queries/yaml/highlights.scm?raw';

export type TreeSitterLanguageEntry = { wasmUrl: string; scm: string };

export const TREE_SITTER_LANGUAGES: Record<string, TreeSitterLanguageEntry> = {
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
  csharp: { wasmUrl: csharp_wasm, scm: csharp_scm },
  java: { wasmUrl: java_wasm, scm: java_scm },
  kotlin: { wasmUrl: kotlin_wasm, scm: kotlin_scm },
  ruby: { wasmUrl: ruby_wasm, scm: ruby_scm },
  php: { wasmUrl: php_wasm, scm: php_scm },
  swift: { wasmUrl: swift_wasm, scm: swift_scm },
  scala: { wasmUrl: scala_wasm, scm: scala_scm },
  lua: { wasmUrl: lua_wasm, scm: lua_scm },
  json: { wasmUrl: json_wasm, scm: json_scm },
  html: { wasmUrl: html_wasm, scm: html_scm },
  vue: { wasmUrl: vue_wasm, scm: vue_scm },
  css: { wasmUrl: css_wasm, scm: css_scm },
  yaml: { wasmUrl: yaml_wasm, scm: yaml_scm },
  toml: { wasmUrl: toml_wasm, scm: toml_scm },
};

export const TS_LANGUAGE_ALIASES: Record<string, string> = {
  shell: 'shell',
  bash: 'shell',
  sh: 'shell',
  zsh: 'shell',
  javascript: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  python: 'python',
  py: 'python',
  rust: 'rust',
  rs: 'rust',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  csharp: 'csharp',
  cs: 'csharp',
  java: 'java',
  kotlin: 'kotlin',
  kt: 'kotlin',
  kts: 'kotlin',
  ruby: 'ruby',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  scala: 'scala',
  lua: 'lua',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  vue: 'vue',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
};

export const resolveTreeSitterLanguageId = (language: string): string | null => {
  if (!language) return null;
  const id = TS_LANGUAGE_ALIASES[language.toLowerCase()] ?? null;
  return id && id in TREE_SITTER_LANGUAGES ? id : null;
};
