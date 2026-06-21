// fix-search-window.mjs
// 算法1：搜索结果命中邻域窗口化（后端裁剪超长行 + 前端贴合/数据级省略号）。
// 根目录执行：node fix-search-window.mjs
// 设计：line_text 改为以命中为中心、按显示列预算裁出的窗口；match_start/end 仍是原行
//       绝对码点偏移（跳转/去重不变）；新增 window_start + truncated_left/right。
//       前端高亮区间 = match_start - window_start，并按截断标志补 “…”。
import { readFileSync, writeFileSync } from 'node:fs';

/** @type {{file:string, replacements:{find:string, replace:string}[]}[]} */
const edits = [
  // ── util.rs：窗口化辅助函数 ────────────────────────────────────────────
  {
    file: 'src-tauri/src/commands/search/util.rs',
    replacements: [
      {
        find: String.raw`pub(super) fn byte_to_char_offset(value: &str, byte_offset: usize) -> usize {
    value[..byte_offset.min(value.len())].chars().count()
}`,
        replace: String.raw`pub(super) fn byte_to_char_offset(value: &str, byte_offset: usize) -> usize {
    value[..byte_offset.min(value.len())].chars().count()
}

/// 命中邻域窗口化：以命中所在的字节区间 [match_start_byte, match_end_byte] 为中心，按显示列
/// 预算从两侧扩展上下文，返回 (窗口文本, 窗口首字符在原行中的码点偏移, 左侧被裁, 右侧被裁)。
/// 命中本身尽量完整保留；列宽按东亚宽度计（CJK/全角/Emoji 记 2 列，其余 1 列）。只在命中两侧
/// 各走至多预算列数 → O(预算)、与行长解耦，超长行不会被整行复制。
pub(super) fn window_around_match(
    line: &str,
    match_start_byte: usize,
    match_end_byte: usize,
) -> (String, u32, bool, bool) {
    // 列预算上界：远超任何侧栏宽度；精确像素贴合交给前端，这里只负责把超长行裁成有界片段。
    const BUDGET_COLS: usize = 200;
    // 命中左侧保留的少量前导上下文：既不贴边，又让命中靠近起点，窄侧栏也能看到。
    const LEFT_MARGIN_COLS: usize = 8;

    let len = line.len();
    let start_byte = match_start_byte.min(len);
    let end_byte = match_end_byte.clamp(start_byte, len);

    let match_cols: usize = line[start_byte..end_byte]
        .chars()
        .map(char_display_cols)
        .sum();

    let left_budget = if match_cols >= BUDGET_COLS {
        0
    } else {
        LEFT_MARGIN_COLS.min(BUDGET_COLS - match_cols)
    };
    let mut window_start_byte = start_byte;
    let mut used_left = 0usize;
    for (offset, ch) in line[..start_byte].char_indices().rev() {
        let cols = char_display_cols(ch);
        if used_left + cols > left_budget {
            break;
        }
        used_left += cols;
        window_start_byte = offset;
    }

    // 命中未超预算：剩余预算全给右侧（命中完整保留）；命中超预算：从命中起点按总预算截断。
    let (right_from_byte, right_budget) = if match_cols >= BUDGET_COLS {
        (start_byte, BUDGET_COLS)
    } else {
        (end_byte, BUDGET_COLS - match_cols - used_left)
    };
    let mut window_end_byte = right_from_byte;
    let mut used_right = 0usize;
    for (offset, ch) in line[right_from_byte..].char_indices() {
        let cols = char_display_cols(ch);
        if used_right + cols > right_budget {
            break;
        }
        used_right += cols;
        window_end_byte = right_from_byte + offset + ch.len_utf8();
    }
    if match_cols < BUDGET_COLS {
        window_end_byte = window_end_byte.max(end_byte);
    }

    let truncated_left = window_start_byte > 0;
    let truncated_right = window_end_byte < len;
    let window_start_char = line[..window_start_byte].chars().count() as u32;
    let windowed = line[window_start_byte..window_end_byte].to_string();
    (windowed, window_start_char, truncated_left, truncated_right)
}

fn char_display_cols(ch: char) -> usize {
    if is_wide_char(ch) {
        2
    } else {
        1
    }
}

/// 东亚宽字符（占 2 个显示列）的码点区间判定：覆盖 CJK 统一表意、假名、谚文、全角符号、
/// CJK 兼容、Emoji 等常见宽字符；其余按 1 列。仅用于窗口列宽估算，不要求严格覆盖 EAW 边角。
fn is_wide_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x1100..=0x115F
            | 0x2329..=0x232A
            | 0x2E80..=0x303E
            | 0x3041..=0x33FF
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xA000..=0xA4CF
            | 0xA960..=0xA97F
            | 0xAC00..=0xD7A3
            | 0xF900..=0xFAFF
            | 0xFE10..=0xFE19
            | 0xFE30..=0xFE6F
            | 0xFF00..=0xFF60
            | 0xFFE0..=0xFFE6
            | 0x1B000..=0x1B16F
            | 0x1F300..=0x1FAFF
            | 0x20000..=0x3FFFD
    )
}`,
      },
    ],
  },

  // ── types.rs：结果结构体新增字段 ──────────────────────────────────────
  {
    file: 'src-tauri/src/commands/search/types.rs',
    replacements: [
      {
        find: String.raw`    pub(crate) match_start: Option<u32>,
    pub(crate) match_end: Option<u32>,
    pub(crate) score: i32,
}`,
        replace: String.raw`    pub(crate) match_start: Option<u32>,
    pub(crate) match_end: Option<u32>,
    /// line_text 已按显示列预算裁成窗口文本；window_start 是窗口首字符在原始整行中的码点
    /// 偏移。前端用 match_start - window_start 得到命中在窗口文本内的高亮区间；match_start /
    /// match_end 仍是原行内的绝对码点偏移（用于编辑器跳转与结果去重）。无窗口结果为 None。
    #[serde(default)]
    pub(crate) window_start: Option<u32>,
    /// 窗口左 / 右两侧是否仍有被裁掉的内容；前端据此渲染数据级省略号（与替换预览口径一致）。
    #[serde(default)]
    pub(crate) truncated_left: bool,
    #[serde(default)]
    pub(crate) truncated_right: bool,
    pub(crate) score: i32,
}`,
      },
    ],
  },

  // ── find.rs：各命中构造点接入窗口化 ──────────────────────────────────
  {
    file: 'src-tauri/src/commands/search/find.rs',
    replacements: [
      // 1) 导入
      {
        find: String.raw`use super::util::{byte_to_char_offset, count_to_u32, i64_to_i32, trim_line, u64_to_u32};`,
        replace: String.raw`use super::util::{
    byte_to_char_offset, count_to_u32, i64_to_i32, trim_line, u64_to_u32, window_around_match,
};`,
      },
      // 2) 文件名命中：无窗口
      {
        find: String.raw`                    line_number: None,
                    line_text: None,
                    match_start: None,
                    match_end: None,
                    score: i64_to_i32(-(score as i64), "搜索评分")?,`,
        replace: String.raw`                    line_number: None,
                    line_text: None,
                    match_start: None,
                    match_end: None,
                    window_start: None,
                    truncated_left: false,
                    truncated_right: false,
                    score: i64_to_i32(-(score as i64), "搜索评分")?,`,
      },
      // 3) 符号命中：无窗口
      {
        find: String.raw`                    line_number: Some(symbol.line_number),
                    line_text: Some(symbol.line_text.clone()),
                    match_start: None,
                    match_end: None,
                    score: i64_to_i32(-(score as i64) + symbol.line_number as i64, "搜索评分")?,`,
        replace: String.raw`                    line_number: Some(symbol.line_number),
                    line_text: Some(symbol.line_text.clone()),
                    match_start: None,
                    match_end: None,
                    window_start: None,
                    truncated_left: false,
                    truncated_right: false,
                    score: i64_to_i32(-(score as i64) + symbol.line_number as i64, "搜索评分")?,`,
      },
      // 4) 模糊内容命中：char 偏移换字节 → 窗口化
      {
        find: String.raw`        let first = indices.iter().copied().min().unwrap_or(0);
        let last = indices.iter().copied().max().unwrap_or(first);
        let line_number = count_to_u32(line_index + 1, "行号")?;

        local.push(WorkspaceSearchResult {
            path: path_display.clone(),
            relative_path: file.relative_path.clone(),
            name: file.name.clone(),
            kind: WorkspaceSearchResultKind::Content,
            line_number: Some(line_number),
            line_text: Some(trim_line(line)),
            match_start: Some(first),
            match_end: Some(last + 1),`,
        replace: String.raw`        let first = indices.iter().copied().min().unwrap_or(0);
        let last = indices.iter().copied().max().unwrap_or(first);
        let line_number = count_to_u32(line_index + 1, "行号")?;
        let trimmed_line = trim_line(line);
        let match_start_byte = trimmed_line
            .char_indices()
            .nth(first as usize)
            .map(|(offset, _)| offset)
            .unwrap_or(trimmed_line.len());
        let match_end_byte = trimmed_line
            .char_indices()
            .nth(last as usize + 1)
            .map(|(offset, _)| offset)
            .unwrap_or(trimmed_line.len());
        let (windowed_text, window_start, truncated_left, truncated_right) =
            window_around_match(&trimmed_line, match_start_byte, match_end_byte);

        local.push(WorkspaceSearchResult {
            path: path_display.clone(),
            relative_path: file.relative_path.clone(),
            name: file.name.clone(),
            kind: WorkspaceSearchResultKind::Content,
            line_number: Some(line_number),
            line_text: Some(windowed_text),
            match_start: Some(first),
            match_end: Some(last + 1),
            window_start: Some(window_start),
            truncated_left,
            truncated_right,`,
      },
      // 5) 结构化命中：头部插入窗口化 + 改 line_text
      {
        find: String.raw`                let match_end = node_match
                    .range()
                    .end
                    .saturating_sub(line_range.start)
                    .min(line.len())
                    .max(match_start);
                local.push(WorkspaceSearchResult {
                    path: path_display.clone(),
                    relative_path: file.relative_path.clone(),
                    name: file.name.clone(),
                    kind: WorkspaceSearchResultKind::Content,
                    line_number: Some(count_to_u32(start.line() + 1, "行号")?),
                    line_text: Some(trim_line(line)),`,
        replace: String.raw`                let match_end = node_match
                    .range()
                    .end
                    .saturating_sub(line_range.start)
                    .min(line.len())
                    .max(match_start);
                let trimmed_line = trim_line(line);
                let (windowed_text, window_start, truncated_left, truncated_right) =
                    window_around_match(&trimmed_line, match_start, match_end);
                local.push(WorkspaceSearchResult {
                    path: path_display.clone(),
                    relative_path: file.relative_path.clone(),
                    name: file.name.clone(),
                    kind: WorkspaceSearchResultKind::Content,
                    line_number: Some(count_to_u32(start.line() + 1, "行号")?),
                    line_text: Some(windowed_text),`,
      },
      // 5b) 结构化命中：match_end 字段之后补 window_start / 截断标志（不依赖 score 表达式）
      {
        find: String.raw`                    match_end: Some(count_to_u32(
                        byte_to_char_offset(line, match_end),
                        "匹配结束列",
                    )?),`,
        replace: String.raw`                    match_end: Some(count_to_u32(
                        byte_to_char_offset(line, match_end),
                        "匹配结束列",
                    )?),
                    window_start: Some(window_start),
                    truncated_left,
                    truncated_right,`,
      },
      // 6) 精确/正则内容命中：push 前插入窗口化 + 改字段
      {
        find: String.raw`                        results.push(WorkspaceSearchResult {
                            path: path_display.clone(),
                            relative_path: file.relative_path.clone(),
                            name: file.name.clone(),
                            kind: WorkspaceSearchResultKind::Content,
                            line_number: Some(line_number),
                            line_text: Some(line_text.clone()),
                            match_start: Some(match_start),
                            match_end: Some(match_end),
                            score,
                        });`,
        replace: String.raw`                        let (windowed_text, window_start, truncated_left, truncated_right) =
                            window_around_match(&line_text, found.start(), found.end());
                        results.push(WorkspaceSearchResult {
                            path: path_display.clone(),
                            relative_path: file.relative_path.clone(),
                            name: file.name.clone(),
                            kind: WorkspaceSearchResultKind::Content,
                            line_number: Some(line_number),
                            line_text: Some(windowed_text),
                            match_start: Some(match_start),
                            match_end: Some(match_end),
                            window_start: Some(window_start),
                            truncated_left,
                            truncated_right,
                            score,
                        });`,
      },
    ],
  },

  // ── 前端：toResultItem 还原高亮区间 + 数据级省略号 ───────────────────
  {
    file: 'src/components/workbench/sidebar/search/useWorkspaceSearch.ts',
    replacements: [
      {
        find: String.raw`      get snippetSegments(): ISnippetSegment[] {
        if (cachedSegments) return cachedSegments;
        const rawSnippetText = result.lineText ?? result.name;
        const rawMatchRange =
          result.matchStart !== null && result.matchEnd !== null
            ? ([result.matchStart, result.matchEnd] as [number, number])
            : null;
        const preview =
          result.lineText === null
            ? { text: rawSnippetText, range: rawMatchRange }
            : trimBoundaryWhitespaceWithRange(rawSnippetText, rawMatchRange);
        cachedSegments =
          result.kind === 'content' && preview.range
            ? toAnchoredSnippetSegments(buildMatchSegments(preview.text, preview.range))
            : toAnchoredSnippetSegments(
                matcher.value.highlight(trimBoundaryWhitespace(preview.text)),
              );
        return cachedSegments;
      },`,
        replace: String.raw`      get snippetSegments(): ISnippetSegment[] {
        if (cachedSegments) return cachedSegments;
        const rawSnippetText = result.lineText ?? result.name;
        // 后端已把命中所在行裁成窗口文本（lineText）；matchStart/End 是原行内的绝对码点偏移，
        // 减去 windowStart 才是命中在窗口文本内的高亮区间。
        const windowStart = result.windowStart ?? 0;
        const rawMatchRange =
          result.matchStart !== null && result.matchEnd !== null
            ? ([result.matchStart - windowStart, result.matchEnd - windowStart] as [
                number,
                number,
              ])
            : null;
        const preview =
          result.lineText === null
            ? { text: rawSnippetText, range: rawMatchRange }
            : trimBoundaryWhitespaceWithRange(rawSnippetText, rawMatchRange);
        if (result.kind === 'content' && preview.range) {
          let segments = toAnchoredSnippetSegments(
            buildMatchSegments(preview.text, preview.range),
          );
          // 窗口两侧仍有内容被裁时补数据级省略号（与替换预览口径一致）。
          if (result.truncatedLeft) {
            segments = [{ text: '…', matched: false, part: 'prefix' }, ...segments];
          }
          if (result.truncatedRight) {
            segments = [...segments, { text: '…', matched: false, part: 'suffix' }];
          }
          cachedSegments = segments;
        } else {
          cachedSegments = toAnchoredSnippetSegments(
            matcher.value.highlight(trimBoundaryWhitespace(preview.text)),
          );
        }
        return cachedSegments;
      },`,
      },
    ],
  },
];

// ── 运行器：CRLF/LF 自适配；逐文件“全部命中才写入” ──────────────────────
let hadError = false;
for (const { file, replacements } of edits) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    hadError = true;
    console.error(`✗ 读取失败：${file} → ${e.message}`);
    continue;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (s) => s.split('\n').join(eol);

  let next = text;
  let ok = true;
  for (let i = 0; i < replacements.length; i++) {
    const find = toEol(replacements[i].find);
    const replace = toEol(replacements[i].replace);
    const hits = next.split(find).length - 1;
    if (hits !== 1) {
      ok = false;
      console.error(`✗ ${file} 第 ${i + 1} 处：期望唯一命中，实际 ${hits} 处`);
      break;
    }
    next = next.replace(find, replace);
  }
  if (!ok) {
    console.error(`  ↳ 跳过写入 ${file}（请确认本地为最新版本）`);
    hadError = true;
    continue;
  }
  if (next !== text) {
    writeFileSync(file, next);
    console.log(`✓ 已更新 ${file}（${replacements.length} 处）`);
  } else {
    console.log(`= 无变化 ${file}`);
  }
}
process.exit(hadError ? 1 : 0);