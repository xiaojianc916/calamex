import { createHash } from 'node:crypto'

import { createMastraMcpClientBundle } from '../tools/mcp.js'
import {
  aiWebFetchInputSchema,
  aiWebFetchPayloadSchema,
  aiWebSearchInputSchema,
  aiWebSearchPayloadSchema,
  aiWebSearchResultSchema,
  type TAiWebFetchInput,
  type TAiWebFetchPayload,
  type TAiWebSearchInput,
  type TAiWebSearchPayload,
} from './types.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const MAX_WEB_SEARCH_RESULTS = 8
const MIN_TAVILY_SEARCH_RESULTS = 5

const WEB_TEXT_REF_PREFIX = 'web-text:'
const WEB_TEXT_REF_HASH_LEN = 16

const WEB_TITLE_CHARS = 120
const WEB_SNIPPET_CHARS = 300
const WEB_EXCERPT_CHARS = 600

/** Tavily 工具单次执行超时（毫秒）。<=0 表示不设超时。 */
const TAVILY_TOOL_TIMEOUT_MS = 30_000

const TAVILY_FIELD = {
  title: 'Title: ',
  url: 'URL: ',
  content: 'Content: ',
  rawContent: 'Raw Content: ',
} as const

const TAVILY_FIELD_PREFIXES = Object.values(TAVILY_FIELD)

const SHARED_ENCODER = new TextEncoder()
const SHARED_DECODER = new TextDecoder('utf-8', { fatal: false })

const OFFICIAL_DOMAINS: ReadonlySet<string> = new Set([
  'w3.org',
  'python.org',
  'mozilla.org',
  'developer.mozilla.org',
  'openai.com',
  'anthropic.com',
  'vercel.com',
  'vercel.app',
  'tauri.app',
  'rust-lang.org',
  'nodejs.org',
  'typescriptlang.org',
])

const FORUM_DOMAINS: ReadonlySet<string> = new Set([
  'stackoverflow.com',
  'stackexchange.com',
  'reddit.com',
  'news.ycombinator.com',
])

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type TMcpTextBlock = {
  type?: string
  text?: string
}

type TMcpToolResult = {
  content?: TMcpTextBlock[]
  error?: boolean
  message?: string
}

type TExecutableTool = {
  execute: (args: unknown) => Promise<unknown>
}

type TTavilyToolName = 'tavily-mcp_tavily-search' | 'tavily-mcp_tavily-extract'
type TMcpBundle = Awaited<ReturnType<typeof createMastraMcpClientBundle>>

type TSearchResult = TAiWebSearchPayload['results'][number]
type TSourceType = TSearchResult['sourceType']

// ---------------------------------------------------------------------------
// MCP 工具与错误处理
// ---------------------------------------------------------------------------

const isExecutableTool = (value: unknown): value is TExecutableTool => {
  if (value === null || typeof value !== 'object') return false
  return typeof (value as { execute?: unknown }).execute === 'function'
}

/** Mastra 在 runtimeContext 缺失时的若干 stack signature，精确匹配避免误吞业务错误。 */
const CONTEXT_SIGNATURE_PATTERNS: readonly RegExp[] = [
  /Cannot read propert(?:y|ies) of undefined \(reading ['"](?:context|runtimeContext)['"]\)/iu,
  /undefined is not an object \(evaluating ['"][^'"]*\.(?:context|runtimeContext)['"]\)/iu,
  /['"]runtimeContext['"] is not defined/iu,
]

const isContextSignatureError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  return CONTEXT_SIGNATURE_PATTERNS.some((p) => p.test(error.message))
}

const readMcpText = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return ''
  const content = (value as TMcpToolResult).content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => (item?.type === 'text' ? (item.text ?? '') : ''))
    .join('\n')
    .trim()
}

const ensureMcpSuccess = (value: unknown, fallbackMessage: string): string => {
  if (value && typeof value === 'object') {
    const record = value as TMcpToolResult
    if (record.error) {
      throw new Error(record.message?.trim() || fallbackMessage)
    }
  }
  const text = readMcpText(value)
  if (!text) throw new Error(fallbackMessage)
  return text
}

// ---------------------------------------------------------------------------
// 共享 MCP bundle（懒加载 + 进程退出统一释放）
// ---------------------------------------------------------------------------

let sharedBundlePromise: Promise<TMcpBundle> | null = null
let shutdownHookRegistered = false

/**
 * 断开 web 搜索使用的共享 tavily MCP bundle。
 * 既被进程信号钩子调用，也可由 sidecar 的统一优雅关闭显式 await，
 * 确保关闭流程结束前 tavily 子进程已被回收，不留孤儿。
 */
export const disposeWebService = async (): Promise<void> => {
  const pending = sharedBundlePromise
  sharedBundlePromise = null
  if (!pending) return
  await pending.then(
    (bundle) => bundle.disconnectAll().catch(() => undefined),
    () => undefined,
  )
}

const registerShutdownHook = (): void => {
  if (shutdownHookRegistered || typeof process === 'undefined') return
  shutdownHookRegistered = true

  const dispose = (): void => {
    void disposeWebService()
  }

  process.once('beforeExit', dispose)
  process.once('SIGINT', dispose)
  process.once('SIGTERM', dispose)
}

const getSharedBundle = async (): Promise<TMcpBundle> => {
  if (!sharedBundlePromise) {
    registerShutdownHook()
    sharedBundlePromise = createMastraMcpClientBundle({
      serverNames: ['tavily-mcp'],
    }).catch((error) => {
      sharedBundlePromise = null
      throw error
    })
  }
  return sharedBundlePromise
}

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  if (timeoutMs <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tavily 工具调用超时(${timeoutMs}ms)：${label}`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const executeTavilyTool = async (
  toolName: TTavilyToolName,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const bundle = await getSharedBundle()
  const tool = bundle.tools[toolName]
  if (!isExecutableTool(tool)) {
    throw new Error(`未找到官方 Tavily MCP 工具：${toolName}`)
  }

  const invoke = (payload: unknown): Promise<unknown> =>
    withTimeout(tool.execute(payload), TAVILY_TOOL_TIMEOUT_MS, toolName)

  try {
    return await invoke(args)
  } catch (error) {
    if (isContextSignatureError(error)) {
      return await invoke({ context: args, runtimeContext: undefined })
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

const clipChars = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return ''
  // Array.from 按 Unicode 码点切，避免把 surrogate pair 切坏
  const chars = Array.from(value)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : value
}

/** UTF-8 字节预算裁剪：encode 一次，回退到非续字节边界。返回裁剪后的字符串及实际字节数。 */
const clipToByteLimit = (
  value: string,
  maxBytes: number,
): { text: string; bytes: number } => {
  if (maxBytes <= 0) return { text: '', bytes: 0 }

  const bytes = SHARED_ENCODER.encode(value)
  if (bytes.byteLength <= maxBytes) {
    return { text: value, bytes: bytes.byteLength }
  }

  let end = maxBytes
  // 回退到字符边界：bytes[end] 不能是 10xxxxxx 续字节
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  const text = SHARED_DECODER.decode(bytes.subarray(0, end))
  return { text, bytes: end }
}

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
}

const decodeNumericEntity = (raw: string): string => {
  const hex = raw.match(/^&#x([0-9a-f]+);$/iu)
  const dec = raw.match(/^&#(\d+);$/u)
  const code = hex
    ? Number.parseInt(hex[1]!, 16)
    : dec
      ? Number.parseInt(dec[1]!, 10)
      : Number.NaN
  if (!Number.isFinite(code) || code < 0 || code > 0x10_ffff) return raw
  try {
    return String.fromCodePoint(code)
  } catch {
    return raw
  }
}

const normalizeExcerptText = (value: string): string =>
  value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/giu, (m) => NAMED_HTML_ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#x?[0-9a-f]+;/giu, decodeNumericEntity)
    .replace(/\s+/gu, ' ')
    .trim()

/** 内容寻址：相同 (url, text) 始终得到相同 refId，天然幂等去重。 */
const buildTextRef = (url: string, text: string): string => {
  const hash = createHash('sha256')
    .update(url)
    .update('\0')
    .update(text)
    .digest('hex')
    .slice(0, WEB_TEXT_REF_HASH_LEN)
  return `${WEB_TEXT_REF_PREFIX}${hash}`
}

// ---------------------------------------------------------------------------
// URL / 来源分类
// ---------------------------------------------------------------------------

type TParsedUrl = { host: string; path: string }

const safeParseUrl = (rawUrl: string): TParsedUrl | null => {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    let host = parsed.hostname.toLowerCase()
    if (host.endsWith('.')) host = host.slice(0, -1)
    return { host, path: parsed.pathname.toLowerCase() }
  } catch {
    return null
  }
}

const matchesDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`)

const isOfficialHost = (host: string): boolean => {
  for (const domain of OFFICIAL_DOMAINS) {
    if (matchesDomain(host, domain)) return true
  }
  return host.endsWith('.gov') || host.endsWith('.edu')
}

const isDocsHost = (host: string, path: string): boolean =>
  host.startsWith('docs.') ||
  host.startsWith('developer.') ||
  host.includes('.docs.') ||
  path.startsWith('/docs') ||
  path.startsWith('/doc/')

const isGithubHost = (host: string): boolean =>
  matchesDomain(host, 'github.com') || host.endsWith('.github.io')

const isForumHost = (host: string): boolean => {
  for (const domain of FORUM_DOMAINS) {
    if (matchesDomain(host, domain)) return true
  }
  return (
    host.startsWith('forum.') ||
    host.startsWith('discourse.') ||
    matchesDomain(host, 'discourse.org')
  )
}

const isBlogHost = (host: string, path: string): boolean =>
  host.startsWith('blog.') || host.endsWith('.blog') || path.startsWith('/blog')

/** 优先级：official > docs > github > forum > blog > unknown */
const classifySourceType = (rawUrl: string): TSourceType => {
  const parsed = safeParseUrl(rawUrl)
  if (!parsed) return 'unknown'
  const { host, path } = parsed
  if (isOfficialHost(host)) return 'official'
  if (isDocsHost(host, path)) return 'docs'
  if (isGithubHost(host)) return 'github'
  if (isForumHost(host)) return 'forum'
  if (isBlogHost(host, path)) return 'blog'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Tavily 文本解析
// ---------------------------------------------------------------------------

const isFieldPrefixLine = (line: string): boolean =>
  TAVILY_FIELD_PREFIXES.some((prefix) => line.startsWith(prefix))

type TSearchAccumulator = {
  title?: string
  url?: string
  content?: string[]
}

const buildSearchResult = (acc: TSearchAccumulator): TSearchResult | null => {
  const url = acc.url?.trim()
  if (!url) return null
  const title = acc.title?.trim() || url
  const content = acc.content?.join('\n').trim() ?? ''
  return {
    title: clipChars(title, WEB_TITLE_CHARS),
    url,
    snippet: clipChars(content, WEB_SNIPPET_CHARS),
    sourceType: classifySourceType(url),
    fetchedAt: new Date().toISOString(),
  }
}

const safeParseSearchResult = (candidate: TSearchResult): TSearchResult | null => {
  const parsed = aiWebSearchResultSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

const parseSearchText = (
  text: string,
  input: TAiWebSearchInput,
): TAiWebSearchPayload => {
  const lines = text.split(/\r?\n/gu)
  const results: TSearchResult[] = []
  const seenUrls = new Set<string>()
  let current: TSearchAccumulator = {}
  let activeField: 'content' | null = null

  const flush = (): void => {
    const built = current.url ? buildSearchResult(current) : null
    current = {}
    activeField = null
    if (!built) return
    if (seenUrls.has(built.url)) return
    // 单条 URL 不合规（私网 / 非 http(s) / SSRF 命中）时静默丢弃，不让整次搜索 parse 失败
    const ok = safeParseSearchResult(built)
    if (!ok) return
    seenUrls.add(ok.url)
    results.push(ok)
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()

    if (trimmed.startsWith(TAVILY_FIELD.title)) {
      flush()
      current = { title: trimmed.slice(TAVILY_FIELD.title.length) }
      continue
    }
    if (trimmed.startsWith(TAVILY_FIELD.url)) {
      current.url = trimmed.slice(TAVILY_FIELD.url.length)
      activeField = null
      continue
    }
    if (trimmed.startsWith(TAVILY_FIELD.content)) {
      current.content = [trimmed.slice(TAVILY_FIELD.content.length)]
      activeField = 'content'
      continue
    }
    if (activeField === 'content' && trimmed && !isFieldPrefixLine(trimmed)) {
      current.content?.push(trimmed)
      continue
    }
    if (!trimmed) {
      activeField = null
    }
  }
  flush()

  return aiWebSearchPayloadSchema.parse({
    results: results.slice(0, input.maxResults),
  })
}

const parseExtractText = (
  text: string,
  input: TAiWebFetchInput,
): { title: string; rawContent: string } => {
  const lines = text.split(/\r?\n/gu)
  let title = ''
  let rawContent = ''

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (!title && line.startsWith(TAVILY_FIELD.title)) {
      title = line.slice(TAVILY_FIELD.title.length).trim()
      continue
    }
    if (line.startsWith(TAVILY_FIELD.rawContent)) {
      rawContent = [
        line.slice(TAVILY_FIELD.rawContent.length),
        ...lines.slice(index + 1),
      ]
        .join('\n')
        .trim()
      break
    }
  }

  // Fallback：未匹配到 "Raw Content:" 前缀时，把整段文本（剔除 Title 行）视作正文
  if (!rawContent) {
    const stripped = lines
      .filter((line) => !line.trim().startsWith(TAVILY_FIELD.title))
      .join('\n')
      .trim()
    if (stripped) rawContent = stripped
  }

  if (!rawContent) {
    throw new Error('官方 tavily-extract 未返回正文内容。')
  }

  return { title: title || input.url, rawContent }
}

// ---------------------------------------------------------------------------
// 参数构造
// ---------------------------------------------------------------------------

const toRecencyDays = (recency: TAiWebSearchInput['recency']): number | undefined => {
  switch (recency) {
    case 'day':
      return 1
    case 'week':
      return 7
    case 'month':
      return 30
    case 'year':
      return 365
    default:
      return undefined
  }
}

const buildSearchArgs = (input: TAiWebSearchInput): Record<string, unknown> => {
  const days = toRecencyDays(input.recency)
  return {
    query: input.query, // schema 已经 trim
    topic: input.intent === 'release-notes' ? 'news' : 'general',
    max_results: Math.max(
      MIN_TAVILY_SEARCH_RESULTS,
      Math.min(MAX_WEB_SEARCH_RESULTS, input.maxResults),
    ),
    include_favicon: true,
    include_raw_content: false,
    ...(days ? { days } : {}),
  }
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

export const searchWeb = async (rawInput: unknown): Promise<TAiWebSearchPayload> => {
  const input = aiWebSearchInputSchema.parse(rawInput)
  const result = await executeTavilyTool(
    'tavily-mcp_tavily-search',
    buildSearchArgs(input),
  )
  const text = ensureMcpSuccess(result, '官方 tavily-search 未返回搜索结果。')
  return parseSearchText(text, input)
}

export const fetchWeb = async (rawInput: unknown): Promise<TAiWebFetchPayload> => {
  const input = aiWebFetchInputSchema.parse(rawInput)
  const url = input.url // schema 已经 trim 并通过 SSRF 校验

  const result = await executeTavilyTool('tavily-mcp_tavily-extract', {
    urls: [url],
    extract_depth: 'basic',
    format: 'markdown',
    include_images: false,
    include_favicon: true,
    query: input.reason,
  })
  const text = ensureMcpSuccess(result, '官方 tavily-extract 未返回网页内容。')

  const extracted = parseExtractText(text, input)
  const { text: clipped, bytes } = clipToByteLimit(extracted.rawContent, input.maxBytes)
  const textRef = buildTextRef(url, clipped)

  return aiWebFetchPayloadSchema.parse({
    source: {
      url,
      title: extracted.title,
      textRef,
      excerpt: clipChars(normalizeExcerptText(clipped), WEB_EXCERPT_CHARS),
      bytes,
      fetchedAt: new Date().toISOString(),
      truncated: clipped !== extracted.rawContent,
    },
  })
}