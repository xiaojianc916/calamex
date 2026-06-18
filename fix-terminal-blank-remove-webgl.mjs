// fix-terminal-blank-remove-webgl.mjs
// 根因：commit 698b05d8 起在 _attachTerminalToHost 接线 xterm WebGL 渲染器，
// Windows WebView2 下 WebGL 常把终端画成纯白（无光标、仅 console.warn）。
// 修复：移除整套 WebGL 渲染器（addon / 上下文计数 / context-loss 恢复 / 字段 / 常量 / 依赖），
// 回到 xterm 默认 DOM 渲染器。CRLF 安全、全部命中才写、可重复执行。
import { readFileSync, writeFileSync } from 'node:fs';

let failed = false;
const results = [];

function readNormalized(path) {
  const raw = readFileSync(path, 'utf8');
  const usesCrlf = raw.includes('\r\n');
  return { text: usesCrlf ? raw.replaceAll('\r\n', '\n') : raw, usesCrlf };
}
function writeBack(path, text, usesCrlf) {
  writeFileSync(path, usesCrlf ? text.replaceAll('\n', '\r\n') : text, 'utf8');
}

// ---- src/terminal/session.ts ----
function processSession(text) {
  const stillHasWebgl = /WebglAddon|addon-webgl|_ensurePreferredRenderer|_canUseWebglRenderer|_disposeWebglRenderer|_webglAddonRef|_webglContextLossCleanup|_webglRendererBlocked|activeWebglTerminalContexts|MAX_WEBGL_TERMINAL_CONTEXTS|TERMINAL_ENABLE_WEBGL_RENDERER|TERMINAL_WEBGL_RECOVERY_DELAY_MS/;
  if (!stillHasWebgl.test(text)) return { text, changed: false };

  let c = text;
  const apply = (find, replace, label) => {
    const n = c.split(find).length - 1;
    if (n !== 1) throw new Error(`session.ts: 期望恰好 1 处「${label}」，实际 ${n} 处`);
    c = c.replace(find, replace);
  };

  // 1) import
  apply(`import { WebglAddon } from '@xterm/addon-webgl';\n`, '', 'import WebglAddon');

  // 2) 常量
  apply(
    `const TERMINAL_ENABLE_WEBGL_RENDERER = true;\n` +
    `const TERMINAL_WEBGL_RECOVERY_DELAY_MS = 180;\n` +
    `// 限制同时持有 WebGL 上下文的终端数：浏览器对同时存活的 WebGL context 有硬上限，\n` +
    `// 多终端 tab 各占一个 context 触顶后会整体丢失，故超过阈值的终端回退到默认渲染。\n` +
    `const MAX_WEBGL_TERMINAL_CONTEXTS = 8;\n` +
    `let activeWebglTerminalContexts = 0;\n`,
    '',
    'WebGL 常量',
  );

  // 3) 字段 _webglAddonRef
  apply(
    `  private _fitAddonRef = shallowRef<FitAddon | null>(null);\n` +
    `  private _webglAddonRef = shallowRef<WebglAddon | null>(null);\n`,
    `  private _fitAddonRef = shallowRef<FitAddon | null>(null);\n`,
    '_webglAddonRef 字段',
  );

  // 4) 字段 _webglContextLossCleanup
  apply(`  private _webglContextLossCleanup: { dispose(): void } | null = null;\n`, '', '_webglContextLossCleanup 字段');

  // 5) detach() 内释放
  apply(
    `\n    // 隐藏/卸载时释放 WebGL 上下文，避免多终端 tab 各占一个 context；再次可见时经\n` +
    `    // handleBecomeVisible → _createTerminal → _attachTerminalToHost → _ensurePreferredRenderer 重新获取。\n` +
    `    this._disposeWebglRenderer();\n`,
    '',
    'detach 释放',
  );

  // 6) dispose() 内释放
  apply(
    `    this.detach();\n    this._disposeWebglRenderer();\n    this._terminalRef.value?.dispose();`,
    `    this.detach();\n    this._terminalRef.value?.dispose();`,
    'dispose 释放',
  );

  // 7) _attachTerminalToHost 接线调用
  apply(
    `    // WebGL 渲染器必须在 terminal.open(host) 之后接线，否则没有可用的 canvas 上下文。\n` +
    `    // 这是 _ensurePreferredRenderer 此前缺失的正常调用点（context-loss 恢复路径之外）。\n` +
    `    this._ensurePreferredRenderer();\n` +
    `    this._previousHostSize = {`,
    `    this._previousHostSize = {`,
    'attach 接线调用',
  );

  // 8) renderer-state 注释 + _webglRendererBlocked 字段（正则容忍破折号数量）
  const stateRe = /\n  \/\/ -- Private: renderer state -+\n  private _webglRendererBlocked = false;/;
  if (!stateRe.test(c)) throw new Error('session.ts: 未找到 renderer state 注释/_webglRendererBlocked 字段');
  c = c.replace(stateRe, '');

  // 9) 渲染器方法块整体切除（保留 _clearTerminalTextureAtlas）
  const startMarker = '  // ── 私有：渲染器';
  const endMarker = '  private _clearTerminalTextureAtlas(): void {';
  const s = c.indexOf(startMarker);
  const e = c.indexOf(endMarker);
  if (s === -1 || e === -1 || s >= e) throw new Error('session.ts: 未定位到渲染器方法块');
  c = c.slice(0, s) + c.slice(e);

  // 残留校验
  for (const tok of ['WebglAddon', 'addon-webgl', '_ensurePreferredRenderer', '_canUseWebglRenderer',
    '_disposeWebglRenderer', '_webglAddonRef', '_webglContextLossCleanup', '_webglRendererBlocked',
    'activeWebglTerminalContexts', 'MAX_WEBGL_TERMINAL_CONTEXTS', 'TERMINAL_ENABLE_WEBGL_RENDERER',
    'TERMINAL_WEBGL_RECOVERY_DELAY_MS']) {
    if (c.includes(tok)) throw new Error(`session.ts: 仍残留 WebGL 引用 -> ${tok}`);
  }
  return { text: c, changed: true };
}

// ---- package.json ----
function processPackageJson(text) {
  const find = `    "@xterm/addon-webgl": "^0.19.0",\n`;
  const n = text.split(find).length - 1;
  if (n === 0) return { text, changed: false };
  if (n !== 1) throw new Error(`package.json: 期望恰好 1 处依赖项，实际 ${n} 处`);
  return { text: text.replace(find, ''), changed: true };
}

const targets = [
  { path: 'src/terminal/session.ts', fn: processSession },
  { path: 'package.json', fn: processPackageJson },
];

for (const { path, fn } of targets) {
  try {
    const { text, usesCrlf } = readNormalized(path);
    const { text: out, changed } = fn(text);
    if (!changed) { results.push(`• ${path}: 已是目标状态，跳过`); continue; }
    writeBack(path, out, usesCrlf);
    results.push(`✓ ${path}: 已移除 WebGL${usesCrlf ? '（CRLF 保留）' : ''}`);
  } catch (err) {
    failed = true;
    results.push(`✗ ${path}: ${err.message}`);
  }
}

console.log(results.join('\n'));
console.log(failed
  ? '\n部分失败：未通过校验的文件未写入，请把上面信息发我。'
  : '\n完成。接着执行：pnpm install && pnpm typecheck && pnpm tauri dev');