import { SHIKI_THEME } from '@/constants/shiki'
import { monaco } from '@/utils/monaco'
import {
    bundledLanguagesInfo,
    createHighlighter,
    type BundledLanguage,
    type GrammarState,
    type Highlighter,
    type ThemeRegistrationResolved,
} from 'shiki'

// ──────────────────────────────────────────────────────────────────────────────
// === Config(按项目实际情况调整)===
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 由 shiki 的 bundledLanguagesInfo 在加载时一次性构建:
 *   "rust" → "rust"
 *   "rs"   → "rust"        (alias)
 *   "ts"   → "typescript"  (alias)
 *   ...
 * 任何 shiki 内置支持的语言或别名都能命中。
 */
const SHIKI_LANGUAGE_LOOKUP: ReadonlyMap<string, BundledLanguage> = (() => {
    const map = new Map<string, BundledLanguage>()
    for (const info of bundledLanguagesInfo) {
        const id = info.id as BundledLanguage
        map.set(info.id.toLowerCase(), id)
        for (const alias of info.aliases ?? []) {
            map.set(alias.toLowerCase(), id)
        }
    }
    return map
})()

/** install 时立即加载到 shiki 的语言;其他语言全部按需加载。 */
const BOOTSTRAP_LANGUAGES: BundledLanguage[] = ['typescript']

// ──────────────────────────────────────────────────────────────────────────────
// === 内联工具函数 ===
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Monaco 只接受 6 位无 `#` 的 hex 作为 token 颜色。
 * 把 shiki 主题里可能出现的形态都归一化掉:
 *   "#fff"      → "ffffff"
 *   "#FFAA00"   → "ffaa00"
 *   "#FFAA0080" → "ffaa00"   (丢掉 alpha)
 *   "transparent" / 非法值 → null(调用方应跳过这条 rule)
 */
function normalizeMonacoColor(input: unknown): string | null {
    if (typeof input !== 'string') return null
    let c = input.trim().toLowerCase()
    if (!c) return null
    if (c.startsWith('#')) c = c.slice(1)

    if (/^[0-9a-f]{3}$/.test(c)) {
        c = c[0]! + c[0]! + c[1]! + c[1]! + c[2]! + c[2]!
    } else if (/^[0-9a-f]{4}$/.test(c)) {
        c = c[0]! + c[0]! + c[1]! + c[1]! + c[2]! + c[2]!
    } else if (/^[0-9a-f]{8}$/.test(c)) {
        c = c.slice(0, 6)
    }

    return /^[0-9a-f]{6}$/.test(c) ? c : null
}

/**
 * 把 shiki 解析后的 textmate 主题转成 Monaco 的 IStandaloneThemeData。
 * 这里只取 fg / bg / fontStyle 三件套,够覆盖绝大多数主题。
 */
function textmateThemeToMonacoTheme(
    theme: ThemeRegistrationResolved,
): monaco.editor.IStandaloneThemeData {
    const rules: monaco.editor.ITokenThemeRule[] = []
    const settings = theme.settings ?? theme.tokenColors ?? []

    for (const setting of settings) {
        const style = setting.settings
        if (!style) continue

        const scopes =
            setting.scope === undefined
                ? ['']
                : Array.isArray(setting.scope)
                    ? setting.scope
                    : String(setting.scope)
                        .split(',')
                        .map((s) => s.trim())

        const fg = normalizeMonacoColor(style.foreground)
        const bg = normalizeMonacoColor(style.background)
        const fontStyle = typeof style.fontStyle === 'string' ? style.fontStyle : undefined

        if (!fg && !bg && !fontStyle) continue

        for (const scope of scopes) {
            const rule: monaco.editor.ITokenThemeRule = { token: scope }
            if (fg) rule.foreground = fg
            if (bg) rule.background = bg
            if (fontStyle) rule.fontStyle = fontStyle
            rules.push(rule)
        }
    }

    const colors: Record<string, string> = {}
    for (const [k, v] of Object.entries(theme.colors ?? {})) {
        if (typeof v === 'string') colors[k] = v
    }

    const themeType = theme.type as string
    const base: monaco.editor.BuiltinTheme =
        themeType === 'light' ? 'vs' : themeType === 'hc' ? 'hc-black' : 'vs-dark'

    return { base, inherit: false, rules, colors }
}

// ──────────────────────────────────────────────────────────────────────────────
// === 模块级状态 ===
// ──────────────────────────────────────────────────────────────────────────────

let highlighter: Highlighter | null = null
let monacoBridgeInstalled = false
let installPromise: Promise<void> | null = null
let installState: 'idle' | 'installing' | 'ready' | 'failed' = 'idle'

/** 已注册到 Monaco 的语言 id 缓存,避免每次都遍历 `monaco.languages.getLanguages()`。 */
const registeredMonacoIds = new Set<string>()
let registeredMonacoIdsBootstrapped = false

/** 语言 → token provider 的 disposable,用于热更新 / dispose 时回收。 */
const monacoTokenProviders = new Map<string, monaco.IDisposable>()

/** shikiLanguage → 加载 Promise,做去重。 */
const languageLoadPromises = new Map<BundledLanguage, Promise<void>>()

/** install 时挂上的全局 model 生命周期监听器(onDidCreateModel 等)。 */
const modelLifecycleDisposables: monaco.IDisposable[] = []

let tokenizeErrorWarned = false

// ──────────────────────────────────────────────────────────────────────────────
// === Tokenizer state ===
// ──────────────────────────────────────────────────────────────────────────────

const SHIKI_STATE_TAG = Symbol.for('aster.monaco-shiki.tokenizer-state')

class ShikiTokenizerState implements monaco.languages.IState {
    readonly [SHIKI_STATE_TAG]: true = true

    constructor(private readonly ruleStack: GrammarState | null) { }

    clone(): monaco.languages.IState {
        return new ShikiTokenizerState(this.ruleStack)
    }

    equals(other: monaco.languages.IState): boolean {
        if (!isShikiTokenizerState(other)) return false
        if (this.ruleStack === other.ruleStack) return true
        if (!this.ruleStack || !other.ruleStack) return false

        const selfEquals = (this.ruleStack as unknown as { equals?: (o: GrammarState) => boolean })
            .equals
        if (typeof selfEquals === 'function') {
            try {
                return selfEquals.call(this.ruleStack, other.ruleStack)
            } catch {
                /* 落到结构化签名比较 */
            }
        }

        return grammarStateSignature(this.ruleStack) === grammarStateSignature(other.ruleStack)
    }

    getRuleStack(): GrammarState | null {
        return this.ruleStack
    }
}

function isShikiTokenizerState(value: unknown): value is ShikiTokenizerState {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as Record<symbol, unknown>)[SHIKI_STATE_TAG] === true
    )
}

function grammarStateSignature(state: GrammarState): string {
    try {
        return JSON.stringify(state)
    } catch {
        return Object.prototype.toString.call(state)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// === 语言 / 主题工具 ===
// ──────────────────────────────────────────────────────────────────────────────

const isSupportedLanguage = (language: string): boolean =>
    SHIKI_LANGUAGE_LOOKUP.has(language.toLowerCase())

const toShikiLanguage = (language: string): BundledLanguage | null =>
    SHIKI_LANGUAGE_LOOKUP.get(language.toLowerCase()) ?? null

const bootstrapRegisteredMonacoIds = (): void => {
    if (registeredMonacoIdsBootstrapped) return
    for (const lang of monaco.languages.getLanguages()) {
        registeredMonacoIds.add(lang.id)
    }
    registeredMonacoIdsBootstrapped = true
}

const registerMonacoLanguageId = (language: string): void => {
    if (!isSupportedLanguage(language)) return
    bootstrapRegisteredMonacoIds()
    if (!registeredMonacoIds.has(language)) {
        monaco.languages.register({ id: language })
        registeredMonacoIds.add(language)
    }
}

const syncMonacoTheme = (nextHighlighter: Highlighter): void => {
    const monacoTheme = textmateThemeToMonacoTheme(nextHighlighter.getTheme(SHIKI_THEME))
    const colors = new Set<string>()

    for (const rule of monacoTheme.rules) {
        if (rule.foreground) {
            colors.add(rule.foreground)
        }
    }

    monacoTheme.rules.push(
        ...[...colors].map((color) => ({
            token: `shiki.${color}`,
            foreground: color,
        })),
    )

    monaco.editor.defineTheme(SHIKI_THEME, monacoTheme)
}

// ──────────────────────────────────────────────────────────────────────────────
// === Token provider ===
// ──────────────────────────────────────────────────────────────────────────────

const registerMonacoTokenProvider = (language: string): void => {
    if (!highlighter || !monacoBridgeInstalled || monacoTokenProviders.has(language)) {
        return
    }

    registerMonacoLanguageId(language)
    const shikiLanguage = toShikiLanguage(language)
    if (!shikiLanguage) return

    const disposable = monaco.languages.setTokensProvider(language, {
        getInitialState() {
            return new ShikiTokenizerState(null)
        },

        tokenize(line, state): monaco.languages.ILineTokens {
            if (!isShikiTokenizerState(state)) {
                return {
                    endState: new ShikiTokenizerState(null),
                    tokens: [{ startIndex: 0, scopes: '' }],
                }
            }

            const hl = highlighter
            if (!hl) {
                return {
                    endState: new ShikiTokenizerState(null),
                    tokens: [{ startIndex: 0, scopes: '' }],
                }
            }

            const grammarState = state.getRuleStack()
            const options = {
                lang: shikiLanguage,
                theme: SHIKI_THEME,
                grammarState: grammarState ?? undefined,
            }

            let tokenResult: ReturnType<Highlighter['codeToTokens']> | undefined
            let nextGrammarState: GrammarState | undefined
            try {
                tokenResult = hl.codeToTokens(line, options)
                nextGrammarState = hl.getLastGrammarState(line, options)
            } catch (error) {
                if (!tokenizeErrorWarned) {
                    tokenizeErrorWarned = true
                    console.warn('[monaco-shiki] tokenize failed; falling back to clean state', error)
                }
            }

            if (!tokenResult || !nextGrammarState) {
                return {
                    endState: new ShikiTokenizerState(null),
                    tokens: [{ startIndex: 0, scopes: '' }],
                }
            }

            const tokens: monaco.languages.IToken[] = []
            let startIndex = 0

            for (const token of tokenResult.tokens[0] ?? []) {
                const color = normalizeMonacoColor(token.color)
                tokens.push({
                    startIndex,
                    scopes: color ? `shiki.${color}` : '',
                })
                startIndex += token.content.length
            }

            if (tokens.length === 0) {
                tokens.push({ startIndex: 0, scopes: '' })
            }

            return {
                endState: new ShikiTokenizerState(nextGrammarState),
                tokens,
            }
        },
    })

    monacoTokenProviders.set(language, disposable)
}

// ──────────────────────────────────────────────────────────────────────────────
// === Model 懒加载钩子 ===
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把 shiki 高亮按需"贴"到一个 model 上:
 * - 现在的语言如果 shiki 支持,立刻登记 Monaco id + 异步加载 grammar。
 * - 监听后续的语言切换,切到支持的语言再加载。
 * - model 销毁时一并清理订阅,避免泄漏。
 */
function attachShikiToModel(model: monaco.editor.ITextModel): void {
    const tryLoad = (language: string): void => {
        if (!toShikiLanguage(language)) return
        registerMonacoLanguageId(language)
        void ensureShikiLanguageLoaded(language)
    }

    tryLoad(model.getLanguageId())

    const langSub = model.onDidChangeLanguage((e) => {
        tryLoad(e.newLanguage ?? model.getLanguageId())
    })

    const willDispose = model.onWillDispose(() => {
        langSub.dispose()
        willDispose.dispose()
    })
}

// ──────────────────────────────────────────────────────────────────────────────
// === Install / lifecycle ===
// ──────────────────────────────────────────────────────────────────────────────

async function install(): Promise<void> {
    installState = 'installing'

    for (const language of BOOTSTRAP_LANGUAGES) {
        registerMonacoLanguageId(language)
    }

    let nextHighlighter: Highlighter | null = null
    try {
        nextHighlighter = await createHighlighter({
            themes: [SHIKI_THEME],
            langs: [...BOOTSTRAP_LANGUAGES] as BundledLanguage[],
        })
        syncMonacoTheme(nextHighlighter)

        // 先把模块级引用切到新 highlighter,再 dispose 旧的,
        // 避免 token provider 闭包里读到正在释放的 WASM 资源。
        const previous = highlighter
        highlighter = nextHighlighter
        monacoBridgeInstalled = true

        if (previous && previous !== nextHighlighter) {
            try {
                previous.dispose()
            } catch (error) {
                console.warn('[monaco-shiki] dispose stale highlighter failed', error)
            }
        }

        // 1) bootstrap 语言已经预热在 highlighter 里,直接挂 provider(免一次空 token 渲染)
        for (const lang of BOOTSTRAP_LANGUAGES) {
            registerMonacoTokenProvider(lang)
        }

        // 2) 监听后续 model 的创建,真正用到哪个语言才懒加载哪个。
        const createSub = monaco.editor.onDidCreateModel((model) => {
            attachShikiToModel(model)
        })
        modelLifecycleDisposables.push(createSub)

        // 3) install 之前就已经存在的 model 也补一遍。
        for (const model of monaco.editor.getModels()) {
            attachShikiToModel(model)
        }

        monaco.editor.setTheme(SHIKI_THEME)
        installState = 'ready'
    } catch (error) {
        if (nextHighlighter && nextHighlighter !== highlighter) {
            try {
                nextHighlighter.dispose()
            } catch (disposeError) {
                console.warn(
                    '[monaco-shiki] dispose nextHighlighter after install failure',
                    disposeError,
                )
            }
        }
        installState = 'failed'
        throw error
    }
}

/**
 * 幂等初始化。第一次调用真正去 install,后续调用复用同一个 Promise。
 *
 * 失败处理:
 * - 进入 `failed` 状态后,**下一次** `ensureMonacoShikiReady` 调用才会重试。
 * - 同一 tick 内对失败的并发等待者会拿到同一份 rejection,
 *   不会触发"失败 → 立刻并发再 install"的竞态。
 *
 * - bootstrap 阶段:`void ensureMonacoShikiReady()` 触发预热
 * - 创建 editor 前:`await ensureMonacoShikiReady()` 确保就绪
 */
export function ensureMonacoShikiReady(): Promise<void> {
    if ((installState === 'ready' || installState === 'installing') && installPromise) {
        return installPromise
    }

    const promise = install().catch((error) => {
        installPromise = null
        throw error
    })
    installPromise = promise
    return promise
}

export async function ensureShikiLanguageLoaded(
    language: string,
): Promise<BundledLanguage | null> {
    const shikiLanguage = toShikiLanguage(language)
    if (!shikiLanguage) return null

    const cached = languageLoadPromises.get(shikiLanguage)
    if (cached) {
        await cached
        registerMonacoTokenProvider(language)
        return shikiLanguage
    }

    const loadPromise = ensureMonacoShikiReady()
        .then(async () => {
            if (!highlighter) return
            if (!highlighter.getLoadedLanguages().includes(shikiLanguage)) {
                await highlighter.loadLanguage(shikiLanguage)
            }
        })
        .catch((error) => {
            languageLoadPromises.delete(shikiLanguage)
            throw error
        })

    languageLoadPromises.set(shikiLanguage, loadPromise)
    await loadPromise
    registerMonacoTokenProvider(language)
    return shikiLanguage
}

export function applyShikiTheme(): void {
    if (typeof monaco.editor.setTheme !== 'function') {
        return
    }

    monaco.editor.setTheme(SHIKI_THEME)
}

/**
 * 返回当前 shiki highlighter,未 init 或 init 失败时返回 null。
 *
 * 通常在 `await ensureMonacoShikiReady()` 之后调用,此时返回值保证非 null。
 */
export function getShikiHighlighter(): Highlighter | null {
    return highlighter
}

// ──────────────────────────────────────────────────────────────────────────────
// === 可选导出:运行时主题切换 / dispose ===
// ──────────────────────────────────────────────────────────────────────────────

let activeShikiTheme: string = SHIKI_THEME

/**
 * 运行时切换 shiki 主题(例如 Dark ↔ Light ↔ HC)。
 * - 会按需 `loadTheme`,并把转译后的 Monaco 主题重新 defineTheme + setTheme。
 * - 注:当前 tokenize 仍引用顶部常量 SHIKI_THEME 作为 shiki 端着色主题,
 *   切换主要影响 Monaco 端展示;如需 shiki 端也跟着切,把 tokenize 里的
 *   `theme: SHIKI_THEME` 改成 `theme: activeShikiTheme`。
 */
export async function setShikiTheme(themeName: string): Promise<void> {
    await ensureMonacoShikiReady()
    if (!highlighter) return

    if (!highlighter.getLoadedThemes().includes(themeName)) {
        await (highlighter.loadTheme as (t: string) => Promise<void>)(themeName)
    }

    const monacoTheme = textmateThemeToMonacoTheme(highlighter.getTheme(themeName))
    monaco.editor.defineTheme(themeName, monacoTheme)
    monaco.editor.setTheme(themeName)
    activeShikiTheme = themeName
}

export function getActiveShikiTheme(): string {
    return activeShikiTheme
}

/**
 * 卸载整个桥接器:释放所有 token provider、dispose highlighter、重置状态。
 * 一般只在测试或 HMR 清理钩子中需要。
 */
export function disposeMonacoShikiBridge(): void {
    for (const d of modelLifecycleDisposables) {
        try {
            d.dispose()
        } catch (error) {
            console.warn('[monaco-shiki] dispose model lifecycle listener failed', error)
        }
    }
    modelLifecycleDisposables.length = 0

    for (const disposable of monacoTokenProviders.values()) {
        try {
            disposable.dispose()
        } catch (error) {
            console.warn('[monaco-shiki] dispose token provider failed', error)
        }
    }
    monacoTokenProviders.clear()
    languageLoadPromises.clear()

    if (highlighter) {
        try {
            highlighter.dispose()
        } catch (error) {
            console.warn('[monaco-shiki] dispose highlighter failed', error)
        }
    }

    highlighter = null
    monacoBridgeInstalled = false
    installPromise = null
    installState = 'idle'
    registeredMonacoIdsBootstrapped = false
    registeredMonacoIds.clear()
    tokenizeErrorWarned = false
}
