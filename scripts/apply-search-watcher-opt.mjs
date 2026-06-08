// scripts/apply-search-watcher-opt.mjs
//
// 审计优化第 3、4 点 codemod（Rust 侧）：
//  3) workspace_watcher.rs：事件去重前置为「在线聚合」(Vec<Event> -> HashMap<path,kind>)。
//  4) search/find.rs：fuzzy 内容搜索在解码前加「文件级字节预筛」，整文件快速跳过。
//
// 只做精确锚点替换；任一锚点未命中/命中多次 => 报错并中止，不写入任何文件。
// 自动向上定位含 src-tauri/src/commands/workspace_watcher.rs 的仓库根；幂等可重复运行。
//
// 用法（仓库根目录）：
//   node scripts/apply-search-watcher-opt.mjs
//   cd src-tauri && cargo fmt && cargo clippy --all-targets && cargo test workspace_watcher && cargo test search

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'src-tauri/src/commands/workspace_watcher.rs';

const findRoot = () => {
  for (const start of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let dir = start;
    for (;;) {
      if (existsSync(joinPath(dir, MARKER))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
};

const root = findRoot();
if (!root) {
  console.error('✗ 未找到含 ' + MARKER + ' 的仓库根目录，请在 calamex 仓库内运行。');
  process.exit(1);
}

const targets = [
  {
    rel: 'src-tauri/src/commands/workspace_watcher.rs',
    edits: [
      {
        name: 'watcher: pending -> HashMap',
        from: [
          '    setup_initial_watches(&mut watcher, &root);',
          '',
          '    // 自实现尾沿去抖：攒到一批事件，安静 DEBOUNCE_DURATION 或攒满 MAX_DEBOUNCE 后吐出。',
          '    let mut pending: Vec<Event> = Vec::new();',
          '    let mut first_at: Option<Instant> = None;',
        ],
        to: [
          '    setup_initial_watches(&mut watcher, &root);',
          '',
          '    // 自实现尾沿去抖：攒到一批事件，安静 DEBOUNCE_DURATION 或攒满 MAX_DEBOUNCE 后吐出。',
          '    // 在线聚合：事件一到就按 path 折叠进 HashMap（只留最高 severity 的 kind），而非先攒',
          '    // 原始 Vec<Event> 到 flush 才去重。事件风暴下内存从 O(原始事件数) 降到 O(唯一路径数)。',
          '    let mut pending: HashMap<String, FsChangeKind> = HashMap::new();',
          '    let mut first_at: Option<Instant> = None;',
        ],
      },
      {
        name: 'watcher: event arm -> ingest_event',
        from: [
          '                if first_at.is_none() {',
          '                    first_at = Some(Instant::now());',
          '                }',
          '                pending.push(event);',
          '                // 事件风暴下的强制上限：攒太久也要吐一次，避免饿死前端刷新。',
          '                if first_at.is_some_and(|t| t.elapsed() >= MAX_DEBOUNCE) {',
          '                    flush_events(&mut pending, &app, &root);',
          '                    first_at = None;',
          '                }',
        ],
        to: [
          '                ingest_event(&mut pending, &root, &event);',
          '                // 整批都是被忽略的噪音（构建/依赖/.git objects 等）时不开窗，避免空 flush。',
          '                if pending.is_empty() {',
          '                    continue;',
          '                }',
          '                if first_at.is_none() {',
          '                    first_at = Some(Instant::now());',
          '                }',
          '                // 事件风暴下的强制上限：攒太久也要吐一次，避免饿死前端刷新。',
          '                if first_at.is_some_and(|t| t.elapsed() >= MAX_DEBOUNCE) {',
          '                    flush_events(&mut pending, &app, &root);',
          '                    first_at = None;',
          '                }',
        ],
      },
      {
        name: 'watcher: flush_events -> ingest_event + flush_events',
        from: [
          '/// 把攒下的一批原始事件展开、过滤、去重后，作为单个 `WorkspaceFsEvent` 推送到前端。',
          'fn flush_events(pending: &mut Vec<Event>, app: &AppHandle, root: &Path) {',
          '    let events = std::mem::take(pending);',
          '    let changes = coalesce_changes(events.iter().flat_map(|event| {',
          '        let kind = classify_event_kind(&event.kind);',
          '        event.paths.iter().filter_map(move |path| {',
          '            if is_ignored_change(root, path) {',
          '                return None;',
          '            }',
          '            Some(FsChange {',
          '                path: path.to_string_lossy().into_owned(),',
          '                kind,',
          '            })',
          '        })',
          '    }));',
          '',
          '    if changes.is_empty() {',
          '        return;',
          '    }',
          '',
          '    let payload = WorkspaceFsEvent {',
          '        changes,',
          '        root_path: root.to_string_lossy().into_owned(),',
          '    };',
          '',
          '    // 强类型 emit：事件名由 impl(Event) 的 `WorkspaceFsEvent::NAME` 统一保证，',
          '    // 避免硬编码字符串与 TS 绑定漂移。',
          '    if let Err(e) = payload.emit(app) {',
          '        log::warn!("发送工作区文件事件失败: {e}");',
          '    }',
          '}',
        ],
        to: [
          '/// 把事件折叠进在线聚合表：分类 + 过滤忽略目录后，按 path 合并保留最高 severity。',
          '///',
          '/// 相比原先「先攒原始 Vec<Event>、flush 时才展开去重」，这里在事件到达时即完成',
          '/// 分类/过滤/去重，事件风暴下内存只随唯一路径数增长。',
          'fn ingest_event(pending: &mut HashMap<String, FsChangeKind>, root: &Path, event: &Event) {',
          '    let kind = classify_event_kind(&event.kind);',
          '    for path in &event.paths {',
          '        if is_ignored_change(root, path) {',
          '            continue;',
          '        }',
          '        merge_change(',
          '            pending,',
          '            FsChange {',
          '                path: path.to_string_lossy().into_owned(),',
          '                kind,',
          '            },',
          '        );',
          '    }',
          '}',
          '',
          '/// 把已在线聚合好的一批变更按 path 排序后，作为单个 `WorkspaceFsEvent` 推送到前端。',
          'fn flush_events(pending: &mut HashMap<String, FsChangeKind>, app: &AppHandle, root: &Path) {',
          '    if pending.is_empty() {',
          '        return;',
          '    }',
          '    let changes = drain_sorted(std::mem::take(pending));',
          '',
          '    let payload = WorkspaceFsEvent {',
          '        changes,',
          '        root_path: root.to_string_lossy().into_owned(),',
          '    };',
          '',
          '    // 强类型 emit：事件名由 impl(Event) 的 `WorkspaceFsEvent::NAME` 统一保证，',
          '    // 避免硬编码字符串与 TS 绑定漂移。',
          '    if let Err(e) = payload.emit(app) {',
          '        log::warn!("发送工作区文件事件失败: {e}");',
          '    }',
          '}',
        ],
      },
      {
        name: 'watcher: coalesce_changes -> merge_change + drain_sorted',
        from: [
          '/// 同批事件按 path 聚合，仅保留 severity 最高的 kind，再按 path 排序保证输出稳定。',
          '///',
          '/// 原先做法是把所有事件展开成 Vec 后 sort + dedup，事件风暴中成本为 O(n log n)。',
          '/// 这里先用 HashMap 在线聚合为唯一路径数 u，再仅对 u 个路径排序：O(n + u log u)。',
          'fn coalesce_changes(changes: impl Iterator<Item = FsChange>) -> Vec<FsChange> {',
          '    let mut by_path: HashMap<String, FsChangeKind> = HashMap::new();',
          '    for change in changes {',
          '        by_path',
          '            .entry(change.path)',
          '            .and_modify(|kind| {',
          '                if severity(change.kind) > severity(*kind) {',
          '                    *kind = change.kind;',
          '                }',
          '            })',
          '            .or_insert(change.kind);',
          '    }',
          '',
          '    let mut changes: Vec<FsChange> = by_path',
          '        .into_iter()',
          '        .map(|(path, kind)| FsChange { path, kind })',
          '        .collect();',
          '    changes.sort_by(|left, right| left.path.cmp(&right.path));',
          '    changes',
          '}',
        ],
        to: [
          '/// 把单条变更折叠进按 path 聚合表：仅保留 severity 最高的 kind。',
          'fn merge_change(by_path: &mut HashMap<String, FsChangeKind>, change: FsChange) {',
          '    by_path',
          '        .entry(change.path)',
          '        .and_modify(|kind| {',
          '            if severity(change.kind) > severity(*kind) {',
          '                *kind = change.kind;',
          '            }',
          '        })',
          '        .or_insert(change.kind);',
          '}',
          '',
          '/// 把在线聚合表展开为按 path 升序排序的稳定列表。',
          '///',
          '/// 事件循环已改为在线聚合（见 `ingest_event`），不再先攒原始事件再 flush 去重：',
          '/// 内存只随唯一路径数 u 增长，flush 仅对 u 个路径排序，O(u log u)。',
          'fn drain_sorted(by_path: HashMap<String, FsChangeKind>) -> Vec<FsChange> {',
          '    let mut changes: Vec<FsChange> = by_path',
          '        .into_iter()',
          '        .map(|(path, kind)| FsChange { path, kind })',
          '        .collect();',
          '    changes.sort_by(|left, right| left.path.cmp(&right.path));',
          '    changes',
          '}',
        ],
      },
      {
        name: 'watcher: test uses merge_change + drain_sorted',
        from: [
          '        let observed = coalesce_changes(',
          '            [',
          '                change("/ws/b.sh", FsChangeKind::Modified),',
          '                change("/ws/a.sh", FsChangeKind::Created),',
          '                change("/ws/b.sh", FsChangeKind::Removed),',
          '                change("/ws/a.sh", FsChangeKind::Modified),',
          '            ]',
          '            .into_iter(),',
          '        );',
          '',
          '        let observed: Vec<(String, FsChangeKind)> = observed',
          '            .into_iter()',
          '            .map(|change| (change.path, change.kind))',
          '            .collect();',
        ],
        to: [
          '        let mut by_path = HashMap::new();',
          '        for entry in [',
          '            change("/ws/b.sh", FsChangeKind::Modified),',
          '            change("/ws/a.sh", FsChangeKind::Created),',
          '            change("/ws/b.sh", FsChangeKind::Removed),',
          '            change("/ws/a.sh", FsChangeKind::Modified),',
          '        ] {',
          '            merge_change(&mut by_path, entry);',
          '        }',
          '',
          '        let observed: Vec<(String, FsChangeKind)> = drain_sorted(by_path)',
          '            .into_iter()',
          '            .map(|change| (change.path, change.kind))',
          '            .collect();',
        ],
      },
    ],
  },
  {
    rel: 'src-tauri/src/commands/search/find.rs',
    edits: [
      {
        name: 'find: add FuzzyLinePrefilter::bytes_may_match',
        from: [
          '        false',
          '    }',
          '}',
          '',
          'fn normalize_prefilter_ascii(byte: u8, match_case: bool) -> u8 {',
        ],
        to: [
          '        false',
          '    }',
          '',
          '    /// 文件级候选筛除（第 4 点两阶段检索的「candidate generation」轻量版）：',
          '    /// 直接在原始字节上检查 query 要求的 ASCII 字符是否全部出现；缺任意一个，',
          '    /// 则整文件不可能有命中行，可在更贵的解码 / 逐行 nucleo 之前整文件跳过。',
          '    ///',
          '    /// 只看 ASCII 字节，且 ASCII 在 UTF-8 / Latin1 等超集编码里编码一致，故无需先解码，',
          '    /// 也不会误杀（required_ascii 为空时返回 true，交回逐行阶段处理）。',
          '    fn bytes_may_match(&self, bytes: &[u8]) -> bool {',
          '        if self.required_ascii.is_empty() {',
          '            return true;',
          '        }',
          '',
          '        let mut missing = self.required_ascii.clone();',
          '        for byte in bytes {',
          '            if !byte.is_ascii() {',
          '                continue;',
          '            }',
          '            let normalized = normalize_prefilter_ascii(*byte, self.match_case);',
          '            if let Some(index) = missing.iter().position(|candidate| *candidate == normalized) {',
          '                missing.swap_remove(index);',
          '                if missing.is_empty() {',
          '                    return true;',
          '                }',
          '            }',
          '        }',
          '',
          '        false',
          '    }',
          '}',
          '',
          'fn normalize_prefilter_ascii(byte: u8, match_case: bool) -> u8 {',
        ],
      },
      {
        name: 'find: file-level skip before decode',
        from: [
          '    let mut local = Vec::new();',
          '    let bytes = match fs::read(&file.path) {',
          '        Ok(bytes) => bytes,',
          '        Err(_) => return Ok(local),',
          '    };',
          '    let Ok((content, _encoding)) = decode_script_bytes(&bytes) else {',
          '        return Ok(local);',
          '    };',
        ],
        to: [
          '    let mut local = Vec::new();',
          '    let bytes = match fs::read(&file.path) {',
          '        Ok(bytes) => bytes,',
          '        Err(_) => return Ok(local),',
          '    };',
          '    // 文件级候选筛除：query 要求的 ASCII 字符若整文件都没有，逐行必然全部落空，',
          '    // 在更贵的解码（编码探测 + 转码）之前整文件跳过。',
          '    if prefilter.is_some_and(|prefilter| !prefilter.bytes_may_match(&bytes)) {',
          '        return Ok(local);',
          '    }',
          '    let Ok((content, _encoding)) = decode_script_bytes(&bytes) else {',
          '        return Ok(local);',
          '    };',
        ],
      },
      {
        name: 'find: add bytes_may_match test',
        from: [
          '    #[test]',
          '    fn fuzzy_prefilter_ignores_non_ascii_for_safety() {',
          '        let prefilter = FuzzyLinePrefilter::new("部署a", false).expect("应创建预过滤器");',
          '        assert!(prefilter.may_match("xxa"));',
          '        assert!(!prefilter.may_match("部署"));',
          '    }',
          '}',
        ],
        to: [
          '    #[test]',
          '    fn fuzzy_prefilter_ignores_non_ascii_for_safety() {',
          '        let prefilter = FuzzyLinePrefilter::new("部署a", false).expect("应创建预过滤器");',
          '        assert!(prefilter.may_match("xxa"));',
          '        assert!(!prefilter.may_match("部署"));',
          '    }',
          '',
          '    #[test]',
          '    fn fuzzy_prefilter_rejects_whole_file_missing_required_ascii() {',
          '        let prefilter = FuzzyLinePrefilter::new("dapnow", false).expect("应创建预过滤器");',
          '        // 整文件含全部要求字符 -> 不跳过（交给逐行精筛）',
          '        assert!(prefilter.bytes_may_match(b"deploy_app_now run"));',
          '        // 整文件缺少字符 w -> 直接整文件跳过',
          '        assert!(!prefilter.bytes_may_match(b"deploy app on prod"));',
          '    }',
          '}',
        ],
      },
    ],
  },
];

const results = [];
for (const target of targets) {
  const path = joinPath(root, target.rel);
  if (!existsSync(path)) {
    console.error('✗ 缺少文件：' + target.rel);
    process.exit(1);
  }
  const original = readFileSync(path, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const j = (lines) => lines.join(eol);
  let next = original;
  const applied = [];
  const skipped = [];
  for (const edit of target.edits) {
    const from = j(edit.from);
    const to = j(edit.to);
    if (next.includes(to)) {
      skipped.push(edit.name);
      continue;
    }
    const count = next.split(from).length - 1;
    if (count !== 1) {
      console.error('✗ [' + target.rel + '] 锚点命中 ' + count + ' 次（期望 1）：' + edit.name + '，已中止，未写入任何文件。');
      process.exit(1);
    }
    next = next.replace(from, to);
    applied.push(edit.name);
  }
  results.push({ path, target, original, next, applied, skipped });
}

for (const r of results) {
  if (r.next !== r.original) writeFileSync(r.path, r.next, 'utf8');
  console.log('✓ ' + r.target.rel + '：应用 ' + r.applied.length + ' 处' + (r.skipped.length ? '，跳过 ' + r.skipped.length + ' 处（已应用）' : ''));
}
console.log('下一步：cd src-tauri && cargo fmt && cargo clippy --all-targets && cargo test workspace_watcher && cargo test search');