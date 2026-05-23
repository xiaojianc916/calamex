import { SHIKI_THEME } from '@/constants/editor/shiki'
import { monaco } from '@/utils/monaco'
import { textmateThemeToMonacoTheme } from '@shikijs/monaco'
import type * as MonacoApi from 'monaco-editor'
import { EncodedTokenMetadata, FontStyle, INITIAL, type StateStack } from 'shiki/textmate'
import {
    bundledLanguagesInfo,
    createHighlighter,
    type BundledLanguage,
    type Highlighter,
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

/** 复合文件在 Shiki 里会按嵌入语言继续分发,打开对应文件时再补齐这些语法。 */
const EMBEDDED_LANGUAGE_DEPENDENCIES: Readonly<Partial<Record<BundledLanguage, readonly BundledLanguage[]>>> = {
    vue: ['typescript', 'javascript', 'html', 'css', 'scss', 'sass', 'less', 'stylus', 'json'],
} as const

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

/** 已同步给官方 @shikijs/monaco provider 的 Monaco language id。 */
const monacoTokenProviderLanguages = new Set<string>()

/** shikiLanguage → 加载 Promise,做去重。 */
const languageLoadPromises = new Map<BundledLanguage, Promise<void>>()

/** install 时挂上的全局 model 生命周期监听器(onDidCreateModel 等)。 */
const modelLifecycleDisposables: MonacoApi.IDisposable[] = []

const SHIKI_TO_MONACO_LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = {
    docker: ['dockerfile'],
    make: ['makefile'],
    shellscript: ['bash', 'shell', 'sh', 'zsh'],
} as const

const SHIKI_TOKENIZE_MAX_LINE_LENGTH = 20_000
const SHIKI_TOKENIZE_TIME_LIMIT_MS = 500
const RE_FONT_STYLE_SPLIT = /[\s,]+/u
const VALID_FONT_STYLES = ['italic', 'bold', 'underline', 'strikethrough'] as const
const VALID_FONT_ALIASES: Readonly<Record<string, string>> = {
    'line-through': 'strikethrough',
}

type TFontStyleText = '' | typeof VALID_FONT_STYLES[number] | `${typeof VALID_FONT_STYLES[number]} ${string}`
type TColorStyleKey = string

/** `highlighter.setTheme()` 返回的 TextMate colorMap,由 github-light 官方主题生成。 */
const themeColorMap: string[] = []
const colorStyleToScopeMap = new Map<TColorStyleKey, string>()

// ──────────────────────────────────────────────────────────────────────────────
// === 语言 / 主题工具 ===
// ──────────────────────────────────────────────────────────────────────────────

const isSupportedLanguage = (language: string): boolean =>
    SHIKI_LANGUAGE_LOOKUP.has(language.toLowerCase())

const toShikiLanguage = (language: string): BundledLanguage | null =>
    SHIKI_LANGUAGE_LOOKUP.get(language.toLowerCase()) ?? null

const resolveShikiLanguageLoadPlan = (language: BundledLanguage): BundledLanguage[] => {
    const languages = [language, ...(EMBEDDED_LANGUAGE_DEPENDENCIES[language] ?? [])]
    return languages.filter((item, index) => languages.indexOf(item) === index)
}

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

const registerMonacoLanguageAlias = (language: string): void => {
    bootstrapRegisteredMonacoIds()
    if (!registeredMonacoIds.has(language)) {
        monaco.languages.register({ id: language })
        registeredMonacoIds.add(language)
    }
}

const registerMonacoAliasesForShikiLanguage = (shikiLanguage: BundledLanguage): void => {
    const aliases = SHIKI_TO_MONACO_LANGUAGE_ALIASES[shikiLanguage] ?? []
    for (const alias of aliases) {
        registerMonacoLanguageAlias(alias)
    }
}

const registerLoadedShikiLanguagesInMonaco = (nextHighlighter: Highlighter): void => {
    for (const language of nextHighlighter.getLoadedLanguages()) {
        registerMonacoLanguageAlias(language)
        registerMonacoAliasesForShikiLanguage(language as BundledLanguage)
    }
}

const resolveLoadedMonacoLanguageIds = (nextHighlighter: Highlighter): Set<string> => {
    const ids = new Set<string>()
    for (const language of nextHighlighter.getLoadedLanguages()) {
        ids.add(language)
        for (const alias of SHIKI_TO_MONACO_LANGUAGE_ALIASES[language] ?? []) {
            ids.add(alias)
        }
    }
    return ids
}

const refreshLanguageModels = (languageIds: ReadonlySet<string>): void => {
    for (const model of monaco.editor.getModels()) {
        const language = model.getLanguageId()
        if (languageIds.has(language)) {
            monaco.editor.setModelLanguage(model, language)
        }
    }
}

const normalizeColor = (color: string | readonly string[] | undefined): string | undefined => {
    const candidate = Array.isArray(color) ? color[0] : color
    if (!candidate) return undefined

    const normalized = candidate.trim().replace(/^#/u, '').toLowerCase()
    if (normalized.length === 3 || normalized.length === 4) {
        return normalized.split('').map((part) => `${part}${part}`).join('')
    }
    return normalized || undefined
}

const normalizeFontStyleString = (fontStyle: string | undefined): TFontStyleText => {
    if (!fontStyle) return ''

    const styles = new Set(
        fontStyle
            .split(RE_FONT_STYLE_SPLIT)
            .map((style) => style.trim().toLowerCase())
            .map((style) => VALID_FONT_ALIASES[style] || style)
            .filter(Boolean),
    )

    return VALID_FONT_STYLES.filter((style) => styles.has(style)).join(' ') as TFontStyleText
}

const normalizeFontStyleBits = (fontStyle: number): TFontStyleText => {
    if (fontStyle <= FontStyle.None) return ''

    const styles: string[] = []
    if ((fontStyle & FontStyle.Italic) !== 0) styles.push('italic')
    if ((fontStyle & FontStyle.Bold) !== 0) styles.push('bold')
    if ((fontStyle & FontStyle.Underline) !== 0) styles.push('underline')
    if ((fontStyle & FontStyle.Strikethrough) !== 0) styles.push('strikethrough')
    return styles.join(' ') as TFontStyleText
}

const getColorStyleKey = (color: string, fontStyle: TFontStyleText): TColorStyleKey => (
    fontStyle ? `${color}|${fontStyle}` : color
)

const rebuildThemeTokenScopeMap = (nextHighlighter: Highlighter, themeName: string): void => {
    const themeResult = nextHighlighter.setTheme(themeName)
    themeColorMap.length = themeResult.colorMap.length

    for (let index = 0; index < themeResult.colorMap.length; index += 1) {
        themeColorMap[index] = themeResult.colorMap[index] ?? ''
    }

    colorStyleToScopeMap.clear()
    const monacoTheme = textmateThemeToMonacoTheme(nextHighlighter.getTheme(themeName))

    for (const rule of monacoTheme.rules) {
        const foreground = normalizeColor(rule.foreground)
        if (!foreground) continue

        const fontStyle = normalizeFontStyleString(rule.fontStyle)
        const key = getColorStyleKey(foreground, fontStyle)
        if (!colorStyleToScopeMap.has(key)) {
            colorStyleToScopeMap.set(key, rule.token)
        }
    }
}

const syncMonacoTheme = (nextHighlighter: Highlighter, themeName = SHIKI_THEME): void => {
    registerLoadedShikiLanguagesInMonaco(nextHighlighter)
    const monacoTheme = textmateThemeToMonacoTheme(nextHighlighter.getTheme(themeName))
    rebuildThemeTokenScopeMap(nextHighlighter, themeName)
    monaco.editor.defineTheme(themeName, monacoTheme)
    monaco.editor.setTheme(themeName)
    refreshLanguageModels(resolveLoadedMonacoLanguageIds(nextHighlighter))
}

// ──────────────────────────────────────────────────────────────────────────────
// === Token provider ===
// ──────────────────────────────────────────────────────────────────────────────

class ShikiTokenizerState implements MonacoApi.languages.IState {
    constructor(readonly ruleStack: StateStack) {}

    clone(): MonacoApi.languages.IState {
        return new ShikiTokenizerState(this.ruleStack)
    }

    equals(other: MonacoApi.languages.IState): boolean {
        return other instanceof ShikiTokenizerState && other.ruleStack === this.ruleStack
    }
}

const findScopeByColorAndStyle = (color: string, fontStyle: number): string => {
    const key = getColorStyleKey(color, normalizeFontStyleBits(fontStyle))
    return colorStyleToScopeMap.get(key) ?? ''
}

const createShikiTokenProvider = (
    nextHighlighter: Highlighter,
    shikiLanguage: BundledLanguage,
): MonacoApi.languages.TokensProvider => ({
    getInitialState() {
        return new ShikiTokenizerState(INITIAL)
    },
    tokenize(line, state) {
        if (line.length >= SHIKI_TOKENIZE_MAX_LINE_LENGTH) {
            return {
                endState: state,
                tokens: [{ startIndex: 0, scopes: '' }],
            }
        }

        const currentState =
            state instanceof ShikiTokenizerState
                ? state.ruleStack
                : INITIAL
        const result = nextHighlighter
            .getLanguage(shikiLanguage)
            .tokenizeLine2(line, currentState, SHIKI_TOKENIZE_TIME_LIMIT_MS)
        const tokens: MonacoApi.languages.IToken[] = []
        const tokenCount = result.tokens.length / 2

        for (let index = 0; index < tokenCount; index += 1) {
            const startIndex = result.tokens[2 * index] ?? 0
            const metadata = result.tokens[(2 * index) + 1] ?? 0
            const color = normalizeColor(themeColorMap[EncodedTokenMetadata.getForeground(metadata)])
            tokens.push({
                startIndex,
                scopes: color ? findScopeByColorAndStyle(color, EncodedTokenMetadata.getFontStyle(metadata)) : '',
            })
        }

        return {
            endState: new ShikiTokenizerState(result.ruleStack),
            tokens: tokens.length ? tokens : [{ startIndex: 0, scopes: '' }],
        }
    },
})

const registerMonacoTokenProvider = (language: string): void => {
    if (!highlighter || !monacoBridgeInstalled || monacoTokenProviderLanguages.has(language)) {
        return
    }

    registerMonacoLanguageId(language)
    const shikiLanguage = toShikiLanguage(language)
    if (!shikiLanguage) return

    registerMonacoAliasesForShikiLanguage(shikiLanguage)
    syncMonacoTheme(highlighter)
    monaco.languages.setTokensProvider(language, createShikiTokenProvider(highlighter, shikiLanguage))
    monacoTokenProviderLanguages.add(language)
    refreshLanguageModels(new Set([language]))
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
function attachShikiToModel(model: MonacoApi.editor.ITextModel): void {
    const tryLoad = (language: string): void => {
        if (!toShikiLanguage(language)) return
        registerMonacoLanguageId(language)
        void ensureShikiLanguageLoaded(language)
    }

    tryLoad(model.getLanguageId())

    const langSub = model.onDidChangeLanguage((e: MonacoApi.editor.IModelLanguageChangedEvent) => {
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
        // 先把模块级引用切到新 highlighter,再 dispose 旧的,
        // 避免 token provider 闭包里读到正在释放的 WASM 资源。
        const previous = highlighter
        highlighter = nextHighlighter
        monacoBridgeInstalled = true
        syncMonacoTheme(nextHighlighter)

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
            for (const languageToLoad of resolveShikiLanguageLoadPlan(shikiLanguage)) {
                if (!highlighter.getLoadedLanguages().includes(languageToLoad)) {
                    await highlighter.loadLanguage(languageToLoad)
                }
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

    syncMonacoTheme(highlighter, themeName)
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

    monacoTokenProviderLanguages.clear()
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
}
