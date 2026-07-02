; 来源：nvim-treesitter/nvim-treesitter runtime/queries/latex/highlights.scm（Apache-2.0）。
(command_name) @function @nospell

(caption
  command: _ @function)

(text) @spell

(text_mode
  command: _ @function @nospell
  content: (curly_group
    (_) @none @spell))

(placeholder) @variable

(key_value_pair
  key: (_) @variable.parameter @nospell
  value: (_))

(curly_group_spec
  (text) @variable.parameter)

(curly_group_value
  (value_literal) @constant)

(brack_group_argc) @variable.parameter

[
  (operator)
  "="
  "_"
  "^"
] @operator

"\\item" @punctuation.special

(delimiter) @punctuation.delimiter

(math_delimiter
  left_command: _ @punctuation.delimiter
  left_delimiter: _ @punctuation.delimiter
  right_command: _ @punctuation.delimiter
  right_delimiter: _ @punctuation.delimiter)

[
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

(begin
  command: _ @module
  name: (curly_group_text
    (text) @label @nospell))

(end
  command: _ @module
  name: (curly_group_text
    (text) @label @nospell))

(new_command_definition
  command: _ @function.macro @nospell)

(old_command_definition
  command: _ @function.macro @nospell)

(let_command_definition
  command: _ @function.macro @nospell)

(environment_definition
  command: _ @function.macro @nospell
  name: (curly_group_text
    (_) @label @nospell))

(theorem_definition
  command: _ @function.macro @nospell
  name: (curly_group_text_list
    (_) @label @nospell))

(paired_delimiter_definition
  command: _ @function.macro @nospell
  declaration: (curly_group_command_name
    (_) @function))

(label_definition
  command: _ @function.macro
  name: (curly_group_label
    (_) @markup.link @nospell))

(label_reference_range
  command: _ @function.macro
  from: (curly_group_label
    (_) @markup.link)
  to: (curly_group_label
    (_) @markup.link))

(label_reference
  command: _ @function.macro
  names: (curly_group_label_list
    (_) @markup.link))

(citation
  command: _ @function.macro @nospell
  keys: (curly_group_text_list) @markup.link @nospell)

(glossary_entry_definition
  command: _ @function.macro @nospell
  name: (curly_group_text
    (_) @markup.link @nospell))

(color_definition
  command: _ @function.macro
  name: (curly_group_text
    (_) @markup.link))

(title_declaration
  command: _ @module
  options: (brack_group
    (_) @markup.heading.1)?
  text: (curly_group
    (_) @markup.heading.1))

(author_declaration
  command: _ @module
  authors: (curly_group_author_list
    (author)+ @markup.heading.1))

(chapter
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.2)?
  text: (curly_group
    (_) @markup.heading.2))

(part
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.2)?
  text: (curly_group
    (_) @markup.heading.2))

(section
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.3)?
  text: (curly_group
    (_) @markup.heading.3))

(subsection
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.4)?
  text: (curly_group
    (_) @markup.heading.4))

(subsubsection
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.5)?
  text: (curly_group
    (_) @markup.heading.5))

(paragraph
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.6)?
  text: (curly_group
    (_) @markup.heading.6))

(subparagraph
  command: _ @module
  toc: (brack_group
    (_) @markup.heading.6)?
  text: (curly_group
    (_) @markup.heading.6))

((generic_command
  command: (command_name) @_name
  arg: (curly_group
    (_) @markup.italic))
  (#any-of? @_name "\\emph" "\\textit" "\\mathit"))

((generic_command
  command: (command_name) @_name
  arg: (curly_group
    (_) @markup.strong))
  (#any-of? @_name "\\textbf" "\\mathbf"))

((generic_command
  (command_name) @keyword.conditional)
  (#any-of? @keyword.conditional "\\fi" "\\else"))

(class_include
  command: _ @keyword.import
  path: (curly_group_path) @string)

(package_include
  command: _ @keyword.import
  paths: (curly_group_path_list) @string)

(latex_include
  command: _ @keyword.import
  path: (curly_group_path) @string.special.path)

(verbatim_include
  command: _ @keyword.import
  path: (curly_group_path) @string.special.path)

(graphics_include
  command: _ @keyword.import
  path: (curly_group_path) @string.special.path)

[
  (displayed_equation)
  (inline_formula)
] @markup.math @nospell

(math_environment
  (_) @markup.math)

[
  (line_comment)
  (block_comment)
  (comment_environment)
] @comment @spell
