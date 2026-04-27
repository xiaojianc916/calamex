import { EAiSupportedLang, type IFenceInfo, type TAiSupportedLang } from '@/types/ai-code';
import { fenceInfoSchema } from '@/types/ai-code.schema';

const FENCE_LANG_PATTERN = /^[a-zA-Z0-9_+-]{0,32}$/;
const SUPPORTED_LANGS = new Set<string>(Object.values(EAiSupportedLang));
const LANG_ALIASES = new Map<string, TAiSupportedLang>([
  ['shell', 'bash'],
  ['shellscript', 'bash'],
  ['bash', 'bash'],
  ['sh', 'sh'],
  ['zsh', 'zsh'],
  ['fish', 'fish'],
  ['typescript', 'ts'],
  ['ts', 'ts'],
  ['javascript', 'js'],
  ['js', 'js'],
  ['tsx', 'tsx'],
  ['jsx', 'jsx'],
  ['vue', 'vue'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['golang', 'go'],
  ['go', 'go'],
  ['py', 'python'],
  ['python', 'python'],
  ['rb', 'ruby'],
  ['ruby', 'ruby'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kotlin', 'kotlin'],
  ['swift', 'swift'],
  ['c', 'c'],
  ['cc', 'cpp'],
  ['c++', 'cpp'],
  ['cpp', 'cpp'],
  ['cs', 'csharp'],
  ['csharp', 'csharp'],
  ['php', 'php'],
  ['json', 'json'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['sql', 'sql'],
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['diff', 'diff'],
  ['patch', 'patch'],
  ['text', 'plaintext'],
  ['txt', 'plaintext'],
  ['plaintext', 'plaintext'],
]);

const normalizeLang = (value: string): TAiSupportedLang | null => {
  const normalized = value.trim().toLowerCase();
  const alias = LANG_ALIASES.get(normalized);
  if (alias) return alias;
  return SUPPORTED_LANGS.has(normalized) ? (normalized as TAiSupportedLang) : null;
};

const detectByShebang = (content: string): TAiSupportedLang | null => {
  const firstLine = content.split('\n', 1)[0]?.trimEnd().toLowerCase() ?? '';
  if (!firstLine.startsWith('#!')) return null;
  if (firstLine.includes('bash')) return 'bash';
  if (firstLine.includes('/sh')) return 'sh';
  if (firstLine.includes('zsh')) return 'zsh';
  if (firstLine.includes('fish')) return 'fish';
  if (firstLine.includes('python')) return 'python';
  if (firstLine.includes('ruby')) return 'ruby';
  return null;
};

const detectByKeyword = (content: string): TAiSupportedLang | null => {
  const value = content.trim();
  if (!value) return null;
  if (/<template[\s>]/.test(value) && /<script\s+setup/.test(value)) return 'vue';
  if (/\bfn\s+main\s*\(/.test(value) && /\blet\s+mut\b/.test(value)) return 'rust';
  if (/\bSELECT\b[\s\S]+\bFROM\b/i.test(value)) return 'sql';
  if (/^diff --git\s/m.test(value) || /^@@\s+-\d+/m.test(value)) return 'diff';
  if (/^\s*[{[]/.test(value)) return 'json';
  if (/^\s*FROM\s+\S+/im.test(value) && /^\s*(RUN|COPY|CMD|ENTRYPOINT)\s+/im.test(value)) {
    return 'dockerfile';
  }
  return null;
};

const parseMeta = (parts: string[]): IFenceInfo['meta'] => {
  const meta: IFenceInfo['meta'] = {};
  for (const part of parts) {
    const [rawKey, rawValue] = part.split('=');
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key || !value) continue;
    if (key === 'path') {
      const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(value);
      const filePath = match?.[1]?.trim();
      if (filePath) meta.filePath = filePath;
      const startLine = Number(match?.[2]);
      const endLine = Number(match?.[3]);
      if (Number.isInteger(startLine) && startLine > 0) meta.startLine = startLine;
      if (Number.isInteger(endLine) && endLine > 0) meta.endLine = endLine;
    }
  }
  return meta;
};

export const parseFenceInfo = (rawInfo: string, content: string, contextLang?: TAiSupportedLang): IFenceInfo => {
  const trimmed = rawInfo.trim();
  const [rawLang = '', ...metaParts] = trimmed.split(/\s+/).filter(Boolean);
  const meta = parseMeta(metaParts);
  let lang: TAiSupportedLang = 'plaintext';
  let source: IFenceInfo['detection']['source'] = 'fallback';
  let confidence = 0.4;

  if (rawLang && FENCE_LANG_PATTERN.test(rawLang)) {
    const normalized = normalizeLang(rawLang);
    if (normalized) {
      lang = normalized;
      source = 'fence';
      confidence = 1;
    }
  } else if (rawLang) {
    source = 'fallback';
    confidence = 0.2;
  }

  if (source === 'fallback' && contextLang) {
    lang = contextLang;
    source = 'context';
    confidence = 0.72;
  }

  if (source === 'fallback') {
    const shebangLang = detectByShebang(content);
    if (shebangLang) {
      lang = shebangLang;
      source = 'shebang';
      confidence = 0.9;
    }
  }

  if (source === 'fallback') {
    const keywordLang = detectByKeyword(content);
    if (keywordLang) {
      lang = keywordLang;
      source = 'keyword';
      confidence = 0.74;
    }
  }

  if (lang === 'diff' || lang === 'patch') {
    meta.isDiff = true;
    meta.isApplyCandidate = true;
  }
  if (meta.filePath) {
    meta.isApplyCandidate = true;
  }

  return fenceInfoSchema.parse({
    rawInfo,
    lang,
    meta,
    detection: { source, confidence },
  });
};

export const isAiSupportedLang = (value: string): value is TAiSupportedLang =>
  SUPPORTED_LANGS.has(value);
