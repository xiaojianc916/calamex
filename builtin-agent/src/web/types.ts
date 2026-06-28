import { z } from 'zod';

// =========================================================================
// Enums
// =========================================================================

export const AI_WEB_SEARCH_INTENTS = [
  'official-docs',
  'api-reference',
  'error-debug',
  'best-practice',
  'release-notes',
  'general',
] as const;

export const AI_WEB_SEARCH_RECENCIES = [
  'any',
  'day',
  'week',
  'month',
  'year',
] as const;

export const AI_WEB_SOURCE_TYPES = [
  'official',
  'docs',
  'github',
  'blog',
  'forum',
  'unknown',
] as const;

// =========================================================================
// Limits — single source of truth
// =========================================================================

export const AI_WEB_LIMITS = {
  /** 用户查询串最大长度。 */
  QUERY_MAX: 240,
  /** 调用方人类可读说明最大长度。 */
  REASON_MAX: 240,
  /** 单次 web_search 返回结果数上限。 */
  RESULTS_MAX: 8,
  /** web_fetch 单次允许读取的最大字节数。 */
  FETCH_MAX_BYTES: 512 * 1024,
  /** URL 字符串长度上限（多数服务远低于此值）。 */
  URL_MAX: 2048,
  /** 防御性：上游 title 字段长度上限。 */
  TITLE_MAX: 512,
  /** 防御性：snippet 长度上限。 */
  SNIPPET_MAX: 2_000,
  /** 防御性：excerpt 长度上限。 */
  EXCERPT_MAX: 4_000,
  /** 不透明文本引用句柄长度上限。 */
  TEXT_REF_MAX: 256,
} as const;

// =========================================================================
// SSRF / hostname allowlist
// =========================================================================

/** RFC 1918 + loopback + link-local + CGNAT + 保留段。 */
const PRIVATE_IPV4_PATTERNS: readonly RegExp[] = [
  /^0\./u, // 0.0.0.0/8  "this network"
  /^10\./u, // 10.0.0.0/8
  /^127\./u, // 127.0.0.0/8 loopback
  /^169\.254\./u, // 169.254.0.0/16 link-local（含 AWS/GCP metadata IP）
  /^192\.168\./u, // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[0-1])\./u, // 172.16.0.0/12
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./u, // 100.64.0.0/10 CGNAT
  /^192\.0\.2\./u, // TEST-NET-1
  /^198\.51\.100\./u, // TEST-NET-2
  /^203\.0\.113\./u, // TEST-NET-3
  /^22[4-9]\./u, // 224.0.0.0/4 multicast (224-239)
  /^23\d\./u, //   multicast 230-239
  /^255\.255\.255\.255$/u, // limited broadcast
] as const;

/** 精确匹配的禁用主机名。 */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '0.0.0.0',
  '::',
  '::1',
  // 云厂商 metadata 服务的命名别名
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
]);

/** 任意层级 host 后缀禁用清单（RFC 6761 + 常见内网约定）。 */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  '.localhost',
  '.local', // mDNS / Bonjour
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.lan',
] as const;

/** 判断字符串是否为 IPv6 私有/受限地址。host 已是 URL.hostname 规范形（无方括号）。 */
const isPrivateIpv6 = (host: string): boolean => {
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;

  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  if (host.startsWith('::ffff:')) {
    const v4 = host.slice('::ffff:'.length);
    return PRIVATE_IPV4_PATTERNS.some((p) => p.test(v4));
  }

  // ULA fc00::/7 → 首段 fc__ 或 fd__
  if (/^f[cd][0-9a-f]{0,2}:/u.test(host)) return true;

  // Link-local fe80::/10 → 首段 fe80–febf
  if (/^fe[89ab][0-9a-f]{0,2}:/u.test(host)) return true;

  // Multicast ff00::/8
  if (/^ff[0-9a-f]{0,2}:/u.test(host)) return true;

  return false;
};

/** 拦截十六进制 / 十进制整数 / 八进制前导零等 IPv4 非规范写法。 */
const looksLikeObfuscatedIpv4 = (host: string): boolean => {
  if (/^0x[0-9a-f]+$/iu.test(host)) return true; // 0x7f000001
  if (/^\d{8,10}$/u.test(host)) return true; // 2130706433
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) && /(^|\.)0\d/u.test(host)) {
    return true; // 0177.0.0.1 之类
  }
  return false;
};

/**
 * 严格校验：仅允许公网可访问的 http(s) URL。
 *
 * 注意：这是 *静态* 校验，无法防御 DNS rebinding。
 * 真正的 web_fetch 实现仍需在解析后的 IP 上重做一次相同检查。
 */
export const isAllowedPublicHttpUrl = (value: string): boolean => {
  if (value.length > AI_WEB_LIMITS.URL_MAX) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // 协议白名单
  const protocol = url.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  // 禁止内嵌凭据
  if (url.username !== '' || url.password !== '') return false;

  // 规范化 host：小写 + 去尾部点
  let host = url.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === '') return false;

  // IPv6 字面量在 URL.hostname 中不再带方括号
  if (BLOCKED_HOSTNAMES.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    return false;
  }

  if (looksLikeObfuscatedIpv4(host)) return false;
  if (PRIVATE_IPV4_PATTERNS.some((p) => p.test(host))) return false;
  if (isPrivateIpv6(host)) return false;

  return true;
};

// =========================================================================
// 基础 schema 复合件
// =========================================================================

export const aiWebSearchIntentSchema = z.enum(AI_WEB_SEARCH_INTENTS);
export const aiWebSearchRecencySchema = z.enum(AI_WEB_SEARCH_RECENCIES);
export const aiWebSourceTypeSchema = z.enum(AI_WEB_SOURCE_TYPES);

/** 公网可访问的 http(s) URL，带 SSRF 静态校验。 */
const safePublicHttpUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_WEB_LIMITS.URL_MAX)
  .refine(isAllowedPublicHttpUrl, {
    message: 'web_fetch 只允许访问公网 http/https URL。',
  });

/** ISO-8601 时间戳，要求显式时区偏移（含 Z）。 */
const isoDateTimeSchema = z.iso.datetime({ offset: true });

// =========================================================================
// web_search
// =========================================================================

export const aiWebSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(AI_WEB_LIMITS.QUERY_MAX),
  intent: aiWebSearchIntentSchema,
  maxResults: z.number().int().min(1).max(AI_WEB_LIMITS.RESULTS_MAX),
  recency: aiWebSearchRecencySchema.optional(),
});

export const aiWebSearchResultSchema = z.object({
  title: z.string().trim().min(1).max(AI_WEB_LIMITS.TITLE_MAX),
  url: safePublicHttpUrlSchema,
  snippet: z.string().max(AI_WEB_LIMITS.SNIPPET_MAX),
  sourceType: aiWebSourceTypeSchema,
  fetchedAt: isoDateTimeSchema,
});

export const aiWebSearchPayloadSchema = z.object({
  results: z.array(aiWebSearchResultSchema).max(AI_WEB_LIMITS.RESULTS_MAX),
});

// =========================================================================
// web_fetch
// =========================================================================

export const aiWebFetchInputSchema = z.object({
  url: safePublicHttpUrlSchema,
  reason: z.string().trim().min(1).max(AI_WEB_LIMITS.REASON_MAX),
  maxBytes: z.number().int().min(1).max(AI_WEB_LIMITS.FETCH_MAX_BYTES),
});

export const aiWebFetchResultSchema = z.object({
  url: safePublicHttpUrlSchema,
  title: z.string().max(AI_WEB_LIMITS.TITLE_MAX),
  textRef: z.string().trim().min(1).max(AI_WEB_LIMITS.TEXT_REF_MAX),
  excerpt: z.string().max(AI_WEB_LIMITS.EXCERPT_MAX),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(AI_WEB_LIMITS.FETCH_MAX_BYTES),
  fetchedAt: isoDateTimeSchema,
  truncated: z.boolean(),
});

export const aiWebFetchPayloadSchema = z.object({
  source: aiWebFetchResultSchema,
});

// =========================================================================
// Inferred types
// =========================================================================

export type TAiWebSearchIntent = z.infer<typeof aiWebSearchIntentSchema>;
export type TAiWebSearchRecency = z.infer<typeof aiWebSearchRecencySchema>;
export type TAiWebSourceType = z.infer<typeof aiWebSourceTypeSchema>;

export type TAiWebSearchInput = z.infer<typeof aiWebSearchInputSchema>;
export type TAiWebSearchResult = z.infer<typeof aiWebSearchResultSchema>;
export type TAiWebSearchPayload = z.infer<typeof aiWebSearchPayloadSchema>;

export type TAiWebFetchInput = z.infer<typeof aiWebFetchInputSchema>;
export type TAiWebFetchResult = z.infer<typeof aiWebFetchResultSchema>;
export type TAiWebFetchPayload = z.infer<typeof aiWebFetchPayloadSchema>;