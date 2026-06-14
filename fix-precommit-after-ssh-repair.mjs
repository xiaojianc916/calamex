import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const files = {
  explorerMutations: path.join(
    root,
    'src/components/workbench/sidebar/explorer/useWorkspaceExplorerMutations.ts',
  ),
  sshSession: path.join(root, 'src/components/workbench/sidebar/ssh/useSshRemoteSession.ts'),
  sshPreviewDialog: path.join(root, 'src/components/workbench/sidebar/ssh/SshFilePreviewDialog.vue'),
  sshContract: path.join(root, 'src-tauri/src/commands/contracts/ssh.rs'),
};

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, before, after) {
  if (before === after) {
    console.log(`- 无变化 ${path.relative(root, file)}`);
    return;
  }
  fs.writeFileSync(file, after);
  console.log(`✓ 已修复 ${path.relative(root, file)}`);
}

function replaceOnce(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`${label} 期望命中 1 处，实际命中 ${count} 处，已中止。`);
  }
  console.log(`✓ 准备修复：${label}`);
  return source.replace(search, replacement);
}

function findFunctionRange(source, marker, fromIndex = 0) {
  const start = source.indexOf(marker, fromIndex);
  if (start === -1) {
    throw new Error(`找不到函数：${marker}`);
  }

  const braceStart = source.indexOf('{', start);
  if (braceStart === -1) {
    throw new Error(`找不到函数起始大括号：${marker}`);
  }

  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth += 1;

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        let end = i + 1;
        if (source[end] === ';') end += 1;
        return [start, end];
      }
    }
  }

  throw new Error(`函数大括号未闭合：${marker}`);
}

function mustache(expr) {
  return '{' + `{ ${expr} }` + '}';
}

function numericToken(id) {
  return '{' + `{${id}` + '}' + '}';
}

// -----------------------------------------------------------------------------
// 1. 修 Biome noControlCharactersInRegex：不用 \x00-\x1f 正则
// -----------------------------------------------------------------------------

{
  const file = files.explorerMutations;
  const before = read(file);
  let after = before;

  const badLine = `    if (/[<>"|?*:\\x00-\\x1f]/.test(name)) {
      return '名称包含非法字符。';
    }
`;

  const fixedLine = `    if ([...name].some((char) => '<>"|?*:'.includes(char) || char.charCodeAt(0) < 32)) {
      return '名称包含非法字符。';
    }
`;

  if (after.includes(badLine)) {
    after = replaceOnce(after, badLine, fixedLine, 'Explorer 文件名非法字符校验移除控制字符正则');
  } else if (after.includes('\\x00-\\x1f')) {
    throw new Error(
      'useWorkspaceExplorerMutations.ts 里仍有 \\x00-\\x1f，但格式不符合预期，请贴该函数片段。',
    );
  }

  writeIfChanged(file, before, after);
}

// -----------------------------------------------------------------------------
// 2. 修 useSshRemoteSession.ts 被破坏的 previewRemoteFile 函数
// -----------------------------------------------------------------------------

{
  const file = files.sshSession;
  const before = read(file);
  let after = before;

  if (!after.includes('const previewRequestVersion = ref(0);')) {
    after = replaceOnce(
      after,
      `  const remoteDirectoryRequestVersion = ref(0);
  const contextMenu = reactive({ open: false, x: 0, y: 0 });
`,
      `  const remoteDirectoryRequestVersion = ref(0);
  const previewRequestVersion = ref(0);
  const contextMenu = reactive({ open: false, x: 0, y: 0 });
`,
      'SSH 预览补 request version',
    );
  }

  const closeMarker = `  const closePreviewDialog = (): void => {`;
  const reloadMarker = `  const reloadPreviewFile = async (): Promise<void> => {`;

  const [, closeEnd] = findFunctionRange(after, closeMarker);
  const reloadStart = after.indexOf(reloadMarker, closeEnd);
  if (reloadStart === -1) {
    throw new Error('找不到 reloadPreviewFile，无法修复 previewRemoteFile 残片。');
  }

  const previewRemoteFileBlock = `

  const previewRemoteFile = async (
    fileItem: ISshFileItem,
    options: { preservePayload?: boolean } = {},
  ): Promise<void> => {
    if (isPreviewLoading.value) return;

    const requestVersion = previewRequestVersion.value + 1;
    previewRequestVersion.value = requestVersion;

    previewFileItem.value = fileItem;
    if (!options.preservePayload) {
      previewPayload.value = null;
    }

    isPreviewLoading.value = true;
    try {
      const result = await tauriService.readSshFile(createSshFileReadRequest(fileItem.path));
      if (requestVersion !== previewRequestVersion.value) return;
      if (previewFileItem.value?.path !== fileItem.path) return;
      previewPayload.value = result;
    } catch (error) {
      if (requestVersion !== previewRequestVersion.value) return;
      const errorMessage =
        error instanceof Error
          ? error.message
          : '\\u8bfb\\u53d6\\u8fdc\\u7aef\\u6587\\u4ef6\\u5931\\u8d25\\u3002';
      message.error(errorMessage);
      previewFileItem.value = null;
      previewPayload.value = null;
    } finally {
      if (requestVersion === previewRequestVersion.value) {
        isPreviewLoading.value = false;
      }
    }
  };

`;

  const between = after.slice(closeEnd, reloadStart);
  if (!between.includes('previewRemoteFile') || between.includes('): Promise<void> =>') || between.includes('=\n  ,')) {
    after = after.slice(0, closeEnd) + previewRemoteFileBlock + after.slice(reloadStart);
    console.log('✓ 准备修复：SSH 预览函数残片');
  }

  if (
    after.includes(`  const resetSessionState = (): void => {
    remoteDirectoryRequestVersion.value += 1;
    isRemoteDirectoryLoading.value = false;
`)
  ) {
    after = replaceOnce(
      after,
      `  const resetSessionState = (): void => {
    remoteDirectoryRequestVersion.value += 1;
    isRemoteDirectoryLoading.value = false;
`,
      `  const resetSessionState = (): void => {
    remoteDirectoryRequestVersion.value += 1;
    previewRequestVersion.value += 1;
    isRemoteDirectoryLoading.value = false;
`,
      'SSH resetSessionState 废弃进行中的预览请求',
    );
  }

  writeIfChanged(file, before, after);
}

// -----------------------------------------------------------------------------
// 3. 修我上一版脚本里为了避免聊天渲染而留下的  props.fileItem.name  这类占位符
// -----------------------------------------------------------------------------

{
  const file = files.sshPreviewDialog;
  if (fs.existsSync(file)) {
    const before = read(file);
    let after = before;

    const map = new Map([
      ['202', 'props.fileItem.name'],
      ['203', 'props.fileItem.path'],
      ['204', "props.isSaving ? '保存中…' : '保存'"],
      ['205', 'byteSizeLabel'],
      ['206', 'lineCountLabel'],
      ['207', 'encodingLabel'],
      ['208', 'lineEndingLabel'],
      ['209', "props.payload?.permission ?? '—'"],
      ['210', "props.payload?.owner ?? '—'"],
      ['211', 'modifiedAtLabel'],
      ['212', 'statusLabel'],
      ['213', 'findCountLabel'],
      ['214', 'lineIndex'],
      ['215', 'segment.text'],
      ['216', 'line.lineIndex + 1'],
      ['217', 'languageInfo.label'],
      ['218', 'cursorPosition.line'],
      ['219', 'cursorPosition.column'],
      ['220', "isWrapped ? '开' : '关'"],
    ]);

    for (const [id, expr] of map) {
      after = after.split(numericToken(id)).join(mustache(expr));
    }

    const rawReplacements = [
      [`> props.fileItem.name </div>`, `>${mustache('props.fileItem.name')}</div>`],
      [`> props.fileItem.path </div>`, `>${mustache('props.fileItem.path')}</div>`],
      [`<span> props.isSaving ? '保存中…' : '保存' </span>`, `<span>${mustache("props.isSaving ? '保存中…' : '保存'")}</span>`],
      [`<b> byteSizeLabel </b>`, `<b>${mustache('byteSizeLabel')}</b>`],
      [`<b> lineCountLabel </b>`, `<b>${mustache('lineCountLabel')}</b>`],
      [`<span class="ssh-preview-dialog__badge"> encodingLabel </span>`, `<span class="ssh-preview-dialog__badge">${mustache('encodingLabel')}</span>`],
      [`<span class="ssh-preview-dialog__badge"> lineEndingLabel </span>`, `<span class="ssh-preview-dialog__badge">${mustache('lineEndingLabel')}</span>`],
      [`<span class="ssh-preview-dialog__mono"> props.payload?.permission ?? '—' </span>`, `<span class="ssh-preview-dialog__mono">${mustache("props.payload?.permission ?? '—'")}</span>`],
      [`<b> props.payload?.owner ?? '—' </b>`, `<b>${mustache("props.payload?.owner ?? '—'")}</b>`],
      [`<b> modifiedAtLabel </b>`, `<b>${mustache('modifiedAtLabel')}</b>`],
      [`<span class="ssh-preview-dialog__search-count"> findCountLabel </span>`, `<span class="ssh-preview-dialog__search-count">${mustache('findCountLabel')}</span>`],
      [`<span> languageInfo.label </span>`, `<span>${mustache('languageInfo.label')}</span>`],
      [`<b>行  cursorPosition.line , 列  cursorPosition.column </b>`, `<b>行 ${mustache('cursorPosition.line')}，列 ${mustache('cursorPosition.column')}</b>`],
      [`<span>换行  isWrapped ? '开' : '关' </span>`, `<span>换行 ${mustache("isWrapped ? '开' : '关'")}</span>`],
      [`<span class="ssh-preview-dialog__footer-segment"> encodingLabel </span>`, `<span class="ssh-preview-dialog__footer-segment">${mustache('encodingLabel')}</span>`],
      [`<span class="ssh-preview-dialog__footer-segment"> lineEndingLabel </span>`, `<span class="ssh-preview-dialog__footer-segment">${mustache('lineEndingLabel')}</span>`],
    ];

    for (const [from, to] of rawReplacements) {
      after = after.split(from).join(to);
    }

    // 这些有换行/空格漂移，用更宽松的替换处理。
    after = after.replace(
      />\s*statusLabel\s*<\/span>/g,
      `>${mustache('statusLabel')}</span>`,
    );
    after = after.replace(
      />\s*lineIndex\s*<\/span>/g,
      `>${mustache('lineIndex')}</span>`,
    );
    after = after.replace(
      />\s*segment\.text\s*<\/span>/g,
      `>${mustache('segment.text')}</span>`,
    );
    after = after.replace(
      />\s*line\.lineIndex \+ 1\s*<\/span>/g,
      `>${mustache('line.lineIndex + 1')}</span>`,
    );

    writeIfChanged(file, before, after);
  }
}

// -----------------------------------------------------------------------------
// 4. 如果上一版 SSH 后端脚本已经用了 payload.name，这里补 Rust 契约字段
// -----------------------------------------------------------------------------

{
  const file = files.sshContract;
  if (fs.existsSync(file)) {
    const before = read(file);
    let after = before;

    const oldBlock = `pub struct SshDirectoryCreateRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<SecretString>,
    pub(crate) remote_directory: String,
}
`;

    const newBlock = `pub struct SshDirectoryCreateRequest {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) auth_mode: String,
    pub(crate) identity_path: Option<String>,
    pub(crate) password: Option<SecretString>,
    pub(crate) remote_directory: String,
    #[serde(default)]
    pub(crate) name: String,
}
`;

    if (after.includes(oldBlock)) {
      after = replaceOnce(after, oldBlock, newBlock, 'SSH 新建目录契约补 name 字段');
    }

    writeIfChanged(file, before, after);
  }
}

console.log('\n修复完成。现在跑：');
console.log('  pnpm biome check --write src/components/workbench/sidebar/explorer/useWorkspaceExplorerMutations.ts src/components/workbench/sidebar/ssh/useSshRemoteSession.ts src/components/workbench/sidebar/ssh/SshFilePreviewDialog.vue');
console.log('  pnpm typecheck');
console.log('  git commit -m "fix(core): 修复已知问题"');