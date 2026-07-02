// fix-startup-ub-lazy-terminal-theme.mjs
// 在仓库根目录运行：node fix-startup-ub-lazy-terminal-theme.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = process.argv[2] ?? 'src/themes/runtime/manager.ts';
const raw = readFileSync(FILE, 'utf8');
const isCRLF = raw.includes('\r\n');
const src = isCRLF ? raw.replace(/\r\n/g, '\n') : raw;

const OLD_APPLY = `    // 缓存派生结果
    this.#currentTokens = tokens;
    this.#currentTerminalTheme = buildTerminalTheme(roles);
    this.#currentId = id;`;

const NEW_APPLY = `    // 缓存派生结果
    this.#currentTokens = tokens;
    // 终端主题仅由 useIntegratedTerminal 消费，且终端在首帧绘制后（双 rAF）才 attach。
    // 不再于切换/init() 的同步关键路径急切构造 buildTerminalTheme：此处置 null 失效，
    // 由 getTerminalTheme() 首次读取时惰性构造并缓存，把该派生移出 mount 前关键路径。
    this.#currentTerminalTheme = null;
    this.#currentId = id;`;

const OLD_GETTER = `  /**
   * 获取当前 xterm 主题对象。
   * 在 init() 调用之前为 null。
   */
  getTerminalTheme(): Readonly<IXtermTheme> | null {
    return this.#currentTerminalTheme;
  }`;

const NEW_GETTER = `  /**
   * 获取当前 xterm 主题对象。
   * 在 init() 调用之前为 null。
   * 惰性构造：init()/切换后首次读取时按当前变体 roles 构造并缓存；切换时被置 null 失效。
   */
  getTerminalTheme(): Readonly<IXtermTheme> | null {
    if (this.#currentTerminalTheme === null && this.#currentTokens !== null) {
      const roles = VARIANT_MAP.get(this.#currentId)?.roles;
      if (roles) {
        this.#currentTerminalTheme = buildTerminalTheme(roles);
      }
    }
    return this.#currentTerminalTheme;
  }`;

const MARKER = '由 getTerminalTheme() 首次读取时惰性构造并缓存';
if (src.includes(MARKER) && !src.includes(OLD_APPLY) && !src.includes(OLD_GETTER)) {
  console.log('[skip] U-B 已应用，无需改动。'); process.exit(0);
}
const a = src.split(OLD_APPLY).length - 1;
const g = src.split(OLD_GETTER).length - 1;
if (a !== 1) { console.error(`[abort] 在 ${FILE} 期望恰好 1 处 #applyVariant 缓存锚点，实际 ${a} 处。源码已变动，拒绝盲改。`); process.exit(1); }
if (g !== 1) { console.error(`[abort] 在 ${FILE} 期望恰好 1 处 getTerminalTheme 锚点，实际 ${g} 处。源码已变动，拒绝盲改。`); process.exit(1); }

let out = src.replace(OLD_APPLY, NEW_APPLY).replace(OLD_GETTER, NEW_GETTER);
out = isCRLF ? out.replace(/\n/g, '\r\n') : out;
writeFileSync(FILE, out, 'utf8');
console.log(`[ok] U-B 已应用（${isCRLF ? 'CRLF' : 'LF'}）。`);