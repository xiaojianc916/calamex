// scripts/fix-remaining-lsp-patches.mjs
// 只修复上一轮 node 1.mjs 里 [miss] 的 5 处（commands.rs 的超时调用点 + parse_completion/parse_hover）。
// CRLF 安全：自动识别文件原本的换行风格，匹配时统一按 LF 比较，写回时还原成原换行风格。
// 用法：node scripts/fix-remaining-lsp-patches.mjs [--dry-run]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const dryRun = process.argv.includes('--dry-run');
const toLf = (s) => s.replace(/\r\n/g, '\n');
const toEol = (s, useCrlf) => (useCrlf ? s.replace(/\n/g, '\r\n') : s);

const apply = (target, patches) => {
  const filePath = join(root, target);
  if (!existsSync(filePath)) { console.warn(`[skip] not found: ${target}`); return; }
  const raw = readFileSync(filePath, 'utf8');
  const useCrlf = raw.includes('\r\n');
  let src = toLf(raw);
  let changed = false;
  for (const [oldStr, newStr] of patches) {
    const oldLf = toLf(oldStr);
    if (!src.includes(oldLf)) { console.warn(`[miss] ${target}\n  expected: ${oldLf.slice(0, 80)}...`); continue; }
    src = src.replace(oldLf, toLf(newStr));
    changed = true;
  }
  if (changed && !dryRun) writeFileSync(filePath, toEol(src, useCrlf), 'utf8');
  console.log(`${changed ? (dryRun ? '[dry-run]' : '[ok]') : '[no-change]'} ${target}`);
};

apply('src-tauri/src/commands/lsp/commands.rs', [
  // 1) initialize 超时
  [
    `        init_params,
        Duration::from_secs(10),
    )`,
    `        init_params,
        LSP_INITIALIZE_TIMEOUT,
    )`,
  ],
  // 2) completion 超时
  [
    `        "textDocument/completion",
        params,
        Duration::from_secs(2),
    )`,
    `        "textDocument/completion",
        params,
        LSP_COMPLETION_TIMEOUT,
    )`,
  ],
  // 3) hover 超时
  [
    `        "textDocument/hover",
        params,
        Duration::from_secs(1),
    )`,
    `        "textDocument/hover",
        params,
        LSP_HOVER_TIMEOUT,
    )`,
  ],
  // 4) parse_completion —— 用真实源码逐字核对过的 oldStr
  [
    `fn parse_completion(result: Value) -> Vec<LspCompletionItem> {
    let items = if let Some(items) = result.get("items").and_then(|v| v.as_array()) {
        items.clone()
    } else if let Some(arr) = result.as_array() {
        arr.clone()
    } else {
        return vec![];
    };
    items
        .into_iter()
        .map(|it| LspCompletionItem {
            label: it["label"].as_str().unwrap_or("").to_string(),
            insert_text: it["insertText"].as_str().map(String::from),
            kind: it["kind"].as_u64().map(|n| n as u32),
            detail: it["detail"].as_str().map(String::from),
            documentation: it["documentation"].as_str().map(String::from).or_else(|| {
                it["documentation"]
                    .get("value")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            }),
        })
        .collect()
}`,
    `fn parse_completion(result: Value) -> Vec<LspCompletionItem> {
    // 用 lsp-types 做协议层解析：字段名/结构由官方 LSP 类型定义保证，
    // 取代此前手写的裸 Value 索引（字段名拼错时会静默返回 None 而非编译报错）。
    let items = match serde_json::from_value::<lsp_types::CompletionResponse>(result) {
        Ok(lsp_types::CompletionResponse::Array(items)) => items,
        Ok(lsp_types::CompletionResponse::List(list)) => list.items,
        Err(_) => return vec![],
    };
    items
        .into_iter()
        .map(|item| LspCompletionItem {
            label: item.label,
            insert_text: item.insert_text,
            // CompletionItemKind 字段私有，用 Serialize 往返取协议线上原始整数。
            kind: item
                .kind
                .and_then(|kind| serde_json::to_value(kind).ok())
                .and_then(|value| value.as_u64())
                .map(|value| value as u32),
            detail: item.detail,
            documentation: item.documentation.map(|documentation| match documentation {
                lsp_types::Documentation::String(text) => text,
                lsp_types::Documentation::MarkupContent(markup) => markup.value,
            }),
        })
        .collect()
}`,
  ],
  // 5) parse_hover
  [
    `fn parse_hover(result: Value) -> Option<LspHoverResult> {
    if result.is_null() {
        return None;
    }
    let contents = result.get("contents")?;
    let text = match contents {
        Value::String(s) => s.clone(),
        Value::Object(o) => o
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o.get("value").and_then(|x| x.as_str()).map(String::from),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\\n\\n"),
        _ => return None,
    };
    if text.is_empty() {
        None
    } else {
        Some(LspHoverResult { contents: text })
    }
}`,
    `fn parse_hover(result: Value) -> Option<LspHoverResult> {
    if result.is_null() {
        return None;
    }
    let hover: lsp_types::Hover = serde_json::from_value(result).ok()?;
    let text = match hover.contents {
        lsp_types::HoverContents::Scalar(marked) => marked_string_to_text(marked),
        lsp_types::HoverContents::Array(items) => items
            .into_iter()
            .map(marked_string_to_text)
            .collect::<Vec<_>>()
            .join("\\n\\n"),
        lsp_types::HoverContents::Markup(markup) => markup.value,
    };
    if text.is_empty() {
        None
    } else {
        Some(LspHoverResult { contents: text })
    }
}

fn marked_string_to_text(marked: lsp_types::MarkedString) -> String {
    match marked {
        lsp_types::MarkedString::String(text) => text,
        lsp_types::MarkedString::LanguageString(language_string) => language_string.value,
    }
}`,
  ],
]);

console.log(dryRun ? '── dry-run complete ──' : '── remaining 5 patches applied ──');