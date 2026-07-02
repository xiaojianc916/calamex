// scripts/f1-remove-webgl.mjs
// 目的：按 F1 结论彻底移除 WebGL（DOM 才是本架构正解），并收掉随之而死的纹理图集耦合。
// 做法：全部为「逐字精确匹配 + 计数校验」；任一锚点对不上就抛错、且在此之前不写任何文件
//       （因此天然幂等、绝不半改）。所有锚点均照 session.ts 现状逐字抄写，不再做花括号扫描/猜测。
//       （上一版脚本正是把布尔字段 _shouldClearTextureAtlasOnViewportSync 误当成方法去扫花括号而崩。）
// 换行符：Windows 下本 .mjs 常被存成 CRLF，而 session.ts 是 LF；故读入与所有锚点统一 toLF 规整
//       后再匹配，避免 \r\n 与 \n 不一致导致 0 命中（上一版 import 锚点 0 命中即因此）。
import { readFileSync, writeFileSync } from 'node:fs';

const SESSION = 'src/domains/terminal/core/session.ts';
const PKG = 'package.json';

const toLF = (s) => s.replace(/\r\n/g, '\n');
let src = toLF(readFileSync(SESSION, 'utf8'));
const done = [];
const countOf = (needle) => src.split(needle).length - 1;

function once(label, oldStr, newStr) {
  const from = toLF(oldStr);
  const n = countOf(from);
  if (n !== 1) throw new Error(`[${label}] 期望恰好 1 处匹配，实际 ${n} 处；文件可能已改动，请人工核对后再跑。`);
  src = src.replace(from, toLF(newStr));
  done.push(label);
}

function exactly(label, oldStr, newStr, expected) {
  const from = toLF(oldStr);
  const n = countOf(from);
  if (n !== expected) throw new Error(`[${label}] 期望 ${expected} 处匹配，实际 ${n} 处；请人工核对后再跑。`);
  src = src.split(from).join(toLF(newStr));
  done.push(`${label}×${expected}`);
}

// A) 移除 WebglAddon import
once(
  'import',
  `import { WebglAddon } from '@xterm/addon-webgl';<br>import { Terminal } from '@xterm/xterm';`,
  `import { Terminal } from '@xterm/xterm';`,
);

// B) 移除 _webglAddon 字段及其注释
once(
  'field:_webglAddon',
  `  private _fitAddonRef = shallowRef<FitAddon | null>(null);<br>  // WebGL(GPU)渲染器附加组件：仅在 terminal.open() 之后加载；上下文丢失时置空并回退 DOM 渲染器。<br>  private _webglAddon: WebglAddon | null = null;`,
  `  private _fitAddonRef = shallowRef<FitAddon | null>(null);`,
);

// C) dispose() 里移除 _webglAddon 置空（上一版会把这行遗留成悬空引用）
once(
  'dispose:_webglAddon',
  `    this._fitAddonRef.value = null;<br>    this._webglAddon = null;<br>    this.session.value = null;`,
  `    this._fitAddonRef.value = null;<br>    this.session.value = null;`,
);

// D) 移除 _activateWebglRenderer 方法及其上方注释块
once(
  'method:_activateWebglRenderer',
  `  // WebGL(GPU)渲染器：xterm 默认 DOM 渲染器在高吞吐输出（yes / cat 大文件 / htop）下，<br>  // DOM reflow/repaint 会成为帧率瓶颈。WebGL2 渲染器把字形合成搬到 GPU，是 VS Code 集成<br>  // 终端的同款范式。必须在 terminal.open() 之后加载（依赖已挂载的 screen 元素）。<br>  private _activateWebglRenderer(terminal: Terminal): void {<br>    if (this._webglAddon) return;<br>    try {<br>      const addon = new WebglAddon();<br>      // GPU 上下文丢失（驱动重置 / 系统休眠唤醒 / WebView 回收 GPU）：释放附加组件，<br>      // xterm 自动回退到 DOM 渲染器，避免终端画面永久冻结。<br>      addon.onContextLoss(() => {<br>        addon.dispose();<br>        if (this._webglAddon === addon) this._webglAddon = null;<br>      });<br>      terminal.loadAddon(addon);<br>      this._webglAddon = addon;<br>    } catch (error) {<br>      // WebGL2 不可用（无 GPU / 上下文创建被拒）：静默回退 DOM 渲染器，不影响功能。<br>      this._webglAddon = null;<br>      terminalLogger.warn('WebGL 渲染器不可用，已回退到 DOM 渲染器', error);<br>    }<br>  }<br><br>  private _attachTerminalToHost(): void {`,
  `  private _attachTerminalToHost(): void {`,
);

// E) _attachTerminalToHost 内被注释掉的 WebGL 激活 → 干净的 DOM-only 说明
once(
  'attach:comment',
  `      terminal.open(host);<br>      // [WebGL 诊断实验] 暂时禁用 WebGL 渲染器，确认空白终端根因；确认后用 --restore 恢复<br>      // this._activateWebglRenderer(terminal);<br>      terminalLogger.warn('[WebGL 诊断] 已禁用 WebGL 渲染器，使用 DOM 回退渲染器');`,
  `      terminal.open(host);<br>      // 本架构使用 xterm DOM 渲染器：多面板常驻 + 隐藏页 0×0 + 主题改 CSS/canvas，<br>      // 与 WebGL 的单活跃 GPU 表面模型结构性冲突，DOM 是正确默认值（见性能审查 F1）。`,
);

// F) 移除纹理图集布尔字段（它是字段，不是方法 —— 上一版脚本正是在这里翻车）
once(
  'field:_shouldClearTextureAtlas',
  `  private _shouldClearTextureAtlasOnViewportSync = false;<br>  private _shouldRefreshViewportOnViewportSync = false;`,
  `  private _shouldRefreshViewportOnViewportSync = false;`,
);

// G) _scheduleViewportSync：删 clearTextureAtlas 选项与其赋值
once(
  'scheduleViewportSync',
  `  private _scheduleViewportSync(options?: {<br>    clearTextureAtlas?: boolean;<br>    refresh?: boolean;<br>    scrollToBottom?: boolean;<br>  }): void {<br>    if (options?.clearTextureAtlas) this._shouldClearTextureAtlasOnViewportSync = true;<br>    if (options?.refresh) this._shouldRefreshViewportOnViewportSync = true;`,
  `  private _scheduleViewportSync(options?: {<br>    refresh?: boolean;<br>    scrollToBottom?: boolean;<br>  }): void {<br>    if (options?.refresh) this._shouldRefreshViewportOnViewportSync = true;`,
);

// H) _refreshTerminalViewportNow：删 atlas 分支（refresh 已由各调用点的 refresh:true 保留）
once(
  'refreshViewportNow',
  `  private _refreshTerminalViewportNow(): void {<br>    const terminal = this._terminalRef.value;<br>    const shouldClearAtlas = this._shouldClearTextureAtlasOnViewportSync;<br>    const shouldRefresh = this._shouldRefreshViewportOnViewportSync || shouldClearAtlas;<br>    const shouldScrollToBottom = this._shouldScrollToBottomOnViewportSync;<br>    this._shouldClearTextureAtlasOnViewportSync = false;<br>    this._shouldRefreshViewportOnViewportSync = false;<br>    this._shouldScrollToBottomOnViewportSync = false;<br>    if (!terminal) return;<br>    if (shouldClearAtlas) this._clearTerminalTextureAtlas();<br>    if (`,
  `  private _refreshTerminalViewportNow(): void {<br>    const terminal = this._terminalRef.value;<br>    const shouldRefresh = this._shouldRefreshViewportOnViewportSync;<br>    const shouldScrollToBottom = this._shouldScrollToBottomOnViewportSync;<br>    this._shouldRefreshViewportOnViewportSync = false;<br>    this._shouldScrollToBottomOnViewportSync = false;<br>    if (!terminal) return;<br>    if (`,
);

// I) 移除 _clearTerminalTextureAtlas 方法（真方法）
once(
  'method:_clearTerminalTextureAtlas',
  `  private _clearTerminalTextureAtlas(): void {<br>    this._terminalRef.value?.clearTextureAtlas();<br>  }<br><br>  // -- Private: viewport helpers -------------------------------------------`,
  `  // -- Private: viewport helpers -------------------------------------------`,
);

// J) 去掉各调用点的 clearTextureAtlas: true（多行 3 处，注意两种缩进 + 单行 2 处）
once(
  'call:handleBecomeVisible',
  `    this._scheduleViewportSync({<br>      clearTextureAtlas: true,<br>      refresh: true,<br>      scrollToBottom: true,<br>    });`,
  `    this._scheduleViewportSync({<br>      refresh: true,<br>      scrollToBottom: true,<br>    });`,
);
exactly(
  'call:renderRecovery',
  `        this._scheduleViewportSync({<br>          clearTextureAtlas: true,<br>          refresh: true,<br>          scrollToBottom: true,<br>        });`,
  `        this._scheduleViewportSync({<br>          refresh: true,<br>          scrollToBottom: true,<br>        });`,
  2,
);
once(
  'call:attach',
  `    this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true, scrollToBottom: true });`,
  `    this._scheduleViewportSync({ refresh: true, scrollToBottom: true });`,
);
once(
  'call:applySettings',
  `    this._scheduleViewportSync({ clearTextureAtlas: true, refresh: true });`,
  `    this._scheduleViewportSync({ refresh: true });`,
);

writeFileSync(SESSION, src);
console.log(`✅ session.ts 已改（${done.length} 处）：` + done.join(' / '));

// K) package.json 移除依赖
let pkg = toLF(readFileSync(PKG, 'utf8'));
const depRe = /\n[ \t]*"@xterm\/addon-webgl":\s*"[^"]*",?/;
if (depRe.test(pkg)) {
  writeFileSync(PKG, pkg.replace(depRe, ''));
  console.log('✅ package.json 已移除 @xterm/addon-webgl（记得 pnpm install 刷新 lockfile）。');
} else {
  console.log('ℹ️ package.json 未见 @xterm/addon-webgl，跳过（可能在其它 workspace 包）。');
}

console.log('▶ 收尾守卫：pnpm typecheck && pnpm lint && pnpm test && (cd src-tauri && cargo clippy) && pnpm guard');
console.log('  本次纯减法：生产本就跑 DOM 渲染器，移除的只是关闭状态下的死路径，UX 不受影响。');