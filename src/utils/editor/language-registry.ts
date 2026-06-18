/**
 * 语言定义注册表 —— editor-language(路径→语言)与 codemirror-language(标签→CM 语言)
 * 两张映射表的唯一数据源(single source of truth)。
 *
 * - 本文件为纯数据,禁止 import `@codemirror/*`,以便被无 CodeMirror 依赖的
 *   editor-language 安全引用。
 * - `id` 为每种语言的「规范 id」(canonical id),editor 与 CodeMirror 共用同一命名空间。
 * - `extensions` / `filenames` 供 editor 做路径解析;`aliases` 供 CodeMirror 归一化原始标签。
 * - `codemirror: true` 表示该语言在 CodeMirror 侧有解析器(参与 CM 解析、标签映射与标签表)。
 *   其余语言仍可由 editor 推断(供 LSP / Shiki 着色),但 CodeMirror 侧回退为纯文本。
 */
export interface ILanguageDefinition {
  /** 规范语言 id(editor 与 CodeMirror 共用)。 */
  readonly id: string;
  /** 展示名(供 CodeMirror 标签表使用)。 */
  readonly label: string;
  /** 文件扩展名(不含前导点,全小写),供 editor 路径解析。 */
  readonly extensions?: readonly string[];
  /** 精确文件名(全小写),供 editor 路径解析,如 `makefile`。 */
  readonly filenames?: readonly string[];
  /** 归一到本语言的其他原始标签(如代码块语言串),供 CodeMirror 使用。 */
  readonly aliases?: readonly string[];
  /** 是否在 CodeMirror 侧具备解析器。 */
  readonly codemirror?: boolean;
}

// 说明:同一扩展名/精确文件名/标签不得映射到多个语言;language-registry.spec.ts 会做漂移守卫。
export const LANGUAGE_DEFINITIONS: readonly ILanguageDefinition[] = [
  // ── 具备 CodeMirror 解析器的语言 ──
  { id: 'shell', label: 'Shell', extensions: ['bash', 'ksh', 'sh'], aliases: ['bash', 'sh', 'zsh', 'shellscript'], codemirror: true },
  { id: 'javascript', label: 'JavaScript', extensions: ['cjs', 'js', 'mjs'], aliases: ['js'], codemirror: true },
  { id: 'jsx', label: 'JSX', extensions: ['jsx'], codemirror: true },
  { id: 'typescript', label: 'TypeScript', extensions: ['cts', 'mts', 'ts'], aliases: ['ts'], codemirror: true },
  { id: 'tsx', label: 'TSX', extensions: ['tsx'], codemirror: true },
  { id: 'html', label: 'HTML', extensions: ['htm', 'html'], aliases: ['htm'], codemirror: true },
  { id: 'vue', label: 'Vue', extensions: ['vue'], codemirror: true },
  { id: 'css', label: 'CSS', extensions: ['css'], codemirror: true },
  { id: 'scss', label: 'SCSS', extensions: ['scss'], codemirror: true },
  { id: 'less', label: 'Less', extensions: ['less'], codemirror: true },
  { id: 'json', label: 'JSON', extensions: ['json', 'jsonc'], aliases: ['jsonc', 'json5'], codemirror: true },
  { id: 'markdown', label: 'Markdown', extensions: ['md', 'mdx'], aliases: ['md'], codemirror: true },
  { id: 'dockerfile', label: 'Dockerfile', filenames: ['dockerfile'], aliases: ['docker'], codemirror: true },
  { id: 'diff', label: 'Diff', aliases: ['patch'], codemirror: true },
  { id: 'c', label: 'C', extensions: ['c', 'h'], aliases: ['h'], codemirror: true },
  { id: 'cpp', label: 'C++', extensions: ['cc', 'cpp', 'cxx', 'hh', 'hpp'], aliases: ['c++'], codemirror: true },
  { id: 'csharp', label: 'C#', extensions: ['cs'], aliases: ['cs', 'c#'], codemirror: true },
  { id: 'dart', label: 'Dart', extensions: ['dart'], codemirror: true },
  { id: 'go', label: 'Go', extensions: ['go'], codemirror: true },
  { id: 'java', label: 'Java', extensions: ['java'], codemirror: true },
  { id: 'kotlin', label: 'Kotlin', extensions: ['kt', 'kts'], aliases: ['kt'], codemirror: true },
  { id: 'lua', label: 'Lua', extensions: ['lua'], codemirror: true },
  { id: 'powershell', label: 'PowerShell', extensions: ['ps1', 'psd1', 'psm1'], aliases: ['ps', 'ps1', 'pwsh'], codemirror: true },
  { id: 'proto', label: 'Protobuf', extensions: ['proto', 'protobuf'], aliases: ['protobuf', 'protocol buffers'], codemirror: true },
  { id: 'python', label: 'Python', extensions: ['py', 'pyi', 'pyw'], aliases: ['py'], codemirror: true },
  { id: 'r', label: 'R', extensions: ['r'], codemirror: true },
  { id: 'ruby', label: 'Ruby', extensions: ['gemspec', 'rake', 'rb', 'rbw'], aliases: ['rb'], codemirror: true },
  { id: 'rust', label: 'Rust', extensions: ['rs'], aliases: ['rs'], codemirror: true },
  { id: 'scala', label: 'Scala', extensions: ['scala'], codemirror: true },
  { id: 'sql', label: 'SQL', extensions: ['sql'], codemirror: true },
  { id: 'latex', label: 'LaTeX', aliases: ['stex', 'tex'], codemirror: true },
  { id: 'swift', label: 'Swift', extensions: ['swift'], codemirror: true },
  { id: 'toml', label: 'TOML', extensions: ['toml'], codemirror: true },
  { id: 'ini', label: 'INI', extensions: ['conf', 'env', 'ini'], aliases: ['properties', 'conf'], codemirror: true },
  { id: 'xml', label: 'XML', extensions: ['svg', 'xml', 'xsd', 'xsl'], aliases: ['svg'], codemirror: true },
  { id: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], aliases: ['yml'], codemirror: true },
  // ── 仅 editor 路径解析(CodeMirror 无解析器;Shiki 仍可着色)──
  { id: 'bat', label: 'Batch', extensions: ['bat'] },
  { id: 'clojure', label: 'Clojure', extensions: ['clj'] },
  { id: 'apex', label: 'Apex', extensions: ['cls'] },
  { id: 'elixir', label: 'Elixir', extensions: ['ex', 'exs'] },
  { id: 'fsharp', label: 'F#', extensions: ['fs'] },
  { id: 'graphql', label: 'GraphQL', extensions: ['gql', 'graphql'] },
  { id: 'haskell', label: 'Haskell', extensions: ['hs'] },
  { id: 'julia', label: 'Julia', extensions: ['jl'] },
  { id: 'objective-c', label: 'Objective-C', extensions: ['m', 'mm'] },
  { id: 'make', label: 'Makefile', extensions: ['makefile'], filenames: ['gnumakefile', 'makefile'] },
  { id: 'mermaid', label: 'Mermaid', extensions: ['mermaid'] },
  { id: 'php', label: 'PHP', extensions: ['php'] },
  { id: 'svelte', label: 'Svelte', extensions: ['svelte'] },
  { id: 'terraform', label: 'Terraform', extensions: ['tf'] },
  { id: 'zig', label: 'Zig', extensions: ['zig'] },
];
