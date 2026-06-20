/**
 * Theme Manager — 运行时主题管理器
 *
 * 职责：
 *  1. 维护变体注册表
 *  2. 读取/持久化当前 variantId
 *  3. 首次启动时按系统偏好（prefers-color-scheme）选择默认变体
 *  4. 执行确定性单向切换管道：Variant → buildComponentTokens → 并行派生
 *  5. 分发 theme-changed 事件，供非 CSS 消费者订阅热更新
 *
 * 单例：同一进程内只存在一个实例，通过 getThemeManager() 取得。
 *
 * 启动顺序（规范 §9.2）：
 *  1. main.ts 最顶层调用 getThemeManager().init()  ← 同步完成 CSS 变量注入
 *  2. createApp().mount()
 *  3. 其他消费者订阅 theme-changed 事件
 */

import { emitCssVars } from '../derive/cssVars';
import { buildTerminalTheme, type IXtermTheme } from '../derive/terminal';
import { buildComponentTokens } from '../tokens/components';
import type {
  IComponentTokens,
  IRoles,
  IThemeChangedDetail,
  IThemeVariant,
  TVariantId,
} from '../tokens/types';
import { dark } from '../variants/dark';
import { light } from '../variants/light';

// ─────────────────────────────────────────────────────────────────────────────
// 变体注册表
// ─────────────────────────────────────────────────────────────────────────────

const VARIANT_REGISTRY: readonly IThemeVariant[] = [
  { id: 'dark', label: '深色', mode: 'dark', roles: dark },
  { id: 'light', label: '浅色', mode: 'light', roles: light },
];

const FALLBACK_VARIANT: IThemeVariant = { id: 'dark', label: '深色', mode: 'dark', roles: dark };

const VARIANT_MAP = new Map<TVariantId, IThemeVariant>(VARIANT_REGISTRY.map((v) => [v.id, v]));

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ide.theme';
const DEFAULT_VARIANT: TVariantId = 'dark';

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

const hasWindow = (): boolean => typeof window !== 'undefined';
const hasDocument = (): boolean => typeof document !== 'undefined';

const isKnownVariantId = (value: unknown): value is TVariantId =>
  typeof value === 'string' && VARIANT_MAP.has(value as TVariantId);

/**
 * 从 localStorage 读取上次持久化的 variantId。
 * 若不存在或无效，返回 null（表示"用户未显式选择"，应跟随系统）。
 */
const readStoredVariantId = (): TVariantId | null => {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isKnownVariantId(raw) ? raw : null;
  } catch {
    // localStorage 可能不可用；返回 null 表示继续跟随系统主题。
    return null;
  }
};

const writeStoredVariantId = (id: TVariantId): void => {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // 隐私模式 / 存储配额满时允许静默失败，避免主题切换被阻断。
  }
};

const resolveSystemPreferredVariantId = (): TVariantId => {
  if (!hasWindow() || typeof window.matchMedia !== 'function') {
    return DEFAULT_VARIANT;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export interface IResolvedTheme {
  variant: 'dark' | 'light';
  roles: Readonly<IRoles>;
  window: {
    background: string;
  };
}

export function resolveTheme(base: TVariantId): IResolvedTheme {
  const variant = VARIANT_MAP.get(base) ?? FALLBACK_VARIANT;

  return {
    variant: variant.mode,
    roles: variant.roles,
    window: {
      background: variant.roles.surface.app,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ThemeManager
// ─────────────────────────────────────────────────────────────────────────────

export class ThemeManager {
  /** 当前激活的变体 */
  #currentId: TVariantId = DEFAULT_VARIANT;

  /** 当前 ComponentTokens 缓存（供消费者同步读取） */
  #currentTokens: IComponentTokens | null = null;

  /** 当前 xterm 主题缓存（供 useIntegratedTerminal 读取） */
  #currentTerminalTheme: IXtermTheme | null = null;

  /** 是否已显式选择（决定是否跟随系统变化） */
  #isExplicitChoice: boolean = false;

  /** 系统主题监听清理函数 */
  #systemThemeCleanup: (() => void) | null = null;

  // ── 初始化 ──────────────────────────────────────────────────────────────────

  /**
   * 在应用启动时调用一次（main.ts 最顶层）。
   * 同步完成 CSS 变量注入，确保渲染前主题就位（避免 FOUC）。
   */
  init(): void {
    const stored = readStoredVariantId();

    if (stored !== null) {
      // 用户曾有显式选择
      this.#isExplicitChoice = true;
      this.#applyVariant(stored, false /* 不写存储，已经存在 */);
    } else {
      // 跟随系统
      this.#isExplicitChoice = false;
      this.#applyVariant(resolveSystemPreferredVariantId(), false);
    }

    this.#bindSystemThemeListener();
  }

  // ── 公开 API ─────────────────────────────────────────────────────────────────

  /**
   * 获取当前激活的变体 ID。
   */
  get(): TVariantId {
    return this.#currentId;
  }

  /**
   * 获取当前变体的渲染模式。
   */
  getMode(): 'dark' | 'light' {
    return VARIANT_MAP.get(this.#currentId)?.mode ?? 'dark';
  }

  /**
   * 获取当前 ComponentTokens（只读快照）。
   * 在 init() 调用之前为 null。
   */
  getTokens(): Readonly<IComponentTokens> | null {
    return this.#currentTokens;
  }

  /**
   * 获取当前 xterm 主题对象。
   * 在 init() 调用之前为 null。
   */
  getTerminalTheme(): Readonly<IXtermTheme> | null {
    return this.#currentTerminalTheme;
  }

  /**
   * 获取当前变体的 IRoles 对象（供派生器二次使用）。
   */
  getRoles(): Readonly<IRoles> | null {
    return VARIANT_MAP.get(this.#currentId)?.roles ?? null;
  }

  /**
   * 列出所有注册的变体。
   */
  list(): readonly IThemeVariant[] {
    return VARIANT_REGISTRY;
  }

  /**
   * 切换到指定变体 ID（用户显式操作）。
   * 会写入 localStorage 并停止跟随系统。
   */
  set(id: TVariantId): void {
    if (!isKnownVariantId(id)) return;
    this.#isExplicitChoice = true;
    this.#applyVariant(id, true);
  }

  /**
   * 在 dark / light 之间切换。
   */
  toggle(): void {
    this.set(this.#currentId === 'dark' ? 'light' : 'dark');
  }

  /**
   * 重置为跟随系统（清除显式选择）。
   */
  resetToSystem(): void {
    this.#isExplicitChoice = false;
    if (hasWindow()) {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* localStorage 可能不可用，重置逻辑继续走内存态。 */
      }
    }
    this.#applyVariant(resolveSystemPreferredVariantId(), false);
  }

  // ── 内部管道 ─────────────────────────────────────────────────────────────────

  /**
   * 确定性单向切换管道：
   *   variant → buildComponentTokens → 并行派生 → 分发事件
   */
  #applyVariant(id: TVariantId, persist: boolean): void {
    const variant = VARIANT_MAP.get(id);
    if (!variant) return;

    const roles = variant.roles;

    // L3
    const tokens = buildComponentTokens(roles);

    // 并行派生
    if (hasDocument()) {
      // CSS 变量注入（同步，阻塞渲染前完成）
      emitCssVars(roles, tokens);

      // html class 切换（供 Tailwind dark: variant 使用）
      const html = document.documentElement;
      html.classList.toggle('dark', variant.mode === 'dark');
      html.classList.toggle('light', variant.mode === 'light');
      html.dataset.theme = variant.mode;
    }

    // 缓存派生结果
    this.#currentTokens = tokens;
    this.#currentTerminalTheme = buildTerminalTheme(roles);
    this.#currentId = id;

    if (persist) {
      writeStoredVariantId(id);
    }

    // 分发事件（CodeMirror / xterm / 其他消费者订阅）
    this.#dispatchThemeChanged(id, variant.mode, tokens);
  }

  // ── 事件分发 ─────────────────────────────────────────────────────────────────

  #dispatchThemeChanged(
    variantId: TVariantId,
    mode: 'dark' | 'light',
    tokens: IComponentTokens,
  ): void {
    if (!hasWindow()) return;

    const detail: IThemeChangedDetail = { variantId, mode, tokens };
    window.dispatchEvent(new CustomEvent('theme-changed', { detail }));
  }

  // ── 系统主题监听 ─────────────────────────────────────────────────────────────

  #bindSystemThemeListener(): void {
    if (!hasWindow() || typeof window.matchMedia !== 'function') return;

    this.#cleanupSystemThemeListener();

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (event: MediaQueryListEvent): void => {
      if (this.#isExplicitChoice) return; // 用户已显式选择，不再跟随
      const newId: TVariantId = event.matches ? 'dark' : 'light';
      this.#applyVariant(newId, false);
    };
    mq.addEventListener('change', handler);
    this.#systemThemeCleanup = () => mq.removeEventListener('change', handler);
  }

  #cleanupSystemThemeListener(): void {
    this.#systemThemeCleanup?.();
    this.#systemThemeCleanup = null;
  }

  /** 销毁单例（测试用途） */
  dispose(): void {
    this.#cleanupSystemThemeListener();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 单例导出
// ─────────────────────────────────────────────────────────────────────────────

let _instance: ThemeManager | null = null;

/**
 * 获取 ThemeManager 单例。
 * 整个应用生命周期只调用一次 init()，其余地方只调用 get/set/list/toggle。
 */
export function getThemeManager(): ThemeManager {
  if (!_instance) {
    _instance = new ThemeManager();
  }
  return _instance;
}

/** 构造一个独立的 ThemeManager 实例（单元测试用，不影响单例） */
export function createThemeManager(): ThemeManager {
  return new ThemeManager();
}

// ─────────────────────────────────────────────────────────────────────────────
// 便捷辅助：订阅主题变化事件
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 订阅 theme-changed 事件并自动回调编辑器适配层的辅助函数。
 * 在编辑器适配层中调用，消除重复事件绑定。
 */
export function onThemeChanged(handler: (detail: IThemeChangedDetail) => void): () => void {
  if (!hasWindow())
    return () => {
      /* noop */
    };

  const listener = (event: CustomEvent<IThemeChangedDetail>): void => {
    handler(event.detail);
  };

  window.addEventListener('theme-changed', listener);
  return () => window.removeEventListener('theme-changed', listener);
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型再导出（供外部消费）
// ─────────────────────────────────────────────────────────────────────────────
export type { IComponentTokens, IThemeChangedDetail, IThemeVariant, TVariantId };
