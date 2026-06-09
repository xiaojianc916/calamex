#!/usr/bin/env node
// 第二阶段:把"运行时按名取用"的 iconify 用法迁移到 @lucide/vue + <LucideIcon>。
// 必须在 phase-1 (codemod-iconify-to-lucide.mjs --write) 之后跑。
// 默认 dry-run;加 --write / -write / -w 才落地。--root 默认为 src。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const WRITE = argv.some((a) => a === '--write' || a === '-write' || a === '-w');
const ri = argv.indexOf('--root');
const ROOT = ri >= 0 ? argv[ri + 1] : 'src';
const IMPORT = "import LucideIcon from '@/components/ui/icon/LucideIcon.vue';";

// 动态图标名清单(dry-run 报告并集)→ 注册表
const NAMES = [
  'activity','alert-triangle','arrow-down-a-z','arrow-left-right','arrow-right','arrow-up','arrow-up-a-z',
  'arrow-up-down','asterisk','at-sign','badge-check','ban','bell','bell-ring','book-open','braces','brackets',
  'brain','brush','bug','calendar','calendar-clock','calendar-minus','chart-bar','chart-column','check',
  'chevron-down','chevron-right','circle','circle-alert','circle-slash','clock','clock-3','cloud','code-xml',
  'coffee','combine','cone','copy','corner-down-left','cpu','database','equal','eye-off','file','file-check',
  'file-clock','file-code','file-code-2','file-digit','file-minus','file-pen-line','file-plus','file-search',
  'file-symlink','file-text','file-x','files','filter','flag','folder','folder-tree','folder-x','git-branch',
  'git-branch-plus','git-commit-horizontal','git-fork','github','globe','grid-3x3','hard-drive','hash',
  'help-circle','image','info','key','layers','list','list-ordered','list-todo','list-tree','loader',
  'loader-circle','lock','log-out','mail','message-circle','message-square','monitor','mouse-pointer','music-2',
  'notebook-pen','octagon-alert','package','paperclip','pencil','play','plug','refresh-cw','repeat','replace',
  'rocket','rotate-cw','ruler','save','scissors','scroll-text','search','send','settings','shield','shield-check',
  'skull','sparkles','square','square-terminal','star','tag','terminal','test-tube','text-cursor-input',
  'timer-off','trash-2','type','undo-2','user-check','video','webhook','workflow','x',
];
const pascal = (n) => n.split('-').map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s)).join('');

// 纯 token 去壳:'icon-[lucide--x]' -> 'x'(不动带额外类的组合串)
const dewrap = (s) => s.replace(/(['"])icon-\[lucide--([a-z0-9-]+)\]\1/g, (_, q, n) => `${q}${n}${q}`);

const SPARKLES_SVG =
  `'<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>` +
  `<path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>'`;

// 已知"动态渲染位"span -> <LucideIcon>(空白宽松匹配,匹配不到不报错,留给最终扫描提示)
const RENDER_RULES = [
  [/<span\s+v-else\s+:class="cn\(iconComponent,\s*iconSize,\s*'text-muted-foreground'\)"\s*\/>/g,
   `<LucideIcon v-else :name="iconComponent" :class="cn(iconSize, 'text-muted-foreground')" />`],
  [/<span\s+:class="\[icon,\s*'size-3\.5'\]"\s*\/>/g, `<LucideIcon :name="icon" class="size-3.5" />`],
  [/<span\s+:class="\[icon,\s*iconClass\]"\s*\/>/g, `<LucideIcon :name="icon" :class="iconClass" />`],
  [/<span\s+:class="\['size-4 shrink-0',\s*statusMap\[props\.status\]\.icon,\s*statusMap\[props\.status\]\.class\]"\s*\/>/g,
   `<LucideIcon :name="statusMap[props.status].icon" :class="['size-4 shrink-0', statusMap[props.status].class]" />`],
  [/<span\s+v-if="glyph\.icon"\s+:class="cn\('size-3\.5',\s*glyph\.icon,\s*glyph\.tone\)"\s+aria-hidden="true"\s*\/>/g,
   `<LucideIcon v-if="glyph.icon" :name="glyph.icon" :class="cn('size-3.5', glyph.tone)" aria-hidden="true" />`],
  [/<span\s+:class="group\.icon"\s+class="git-history-graph-group-icon"\s+aria-hidden="true"\s*\/>/g,
   `<LucideIcon :name="group.icon" class="git-history-graph-group-icon" aria-hidden="true" />`],
  [/<span\s+:class="refIcon\(commitRef\)"\s+class="git-history-graph-ref-icon"\s+aria-hidden="true"\s*\/>/g,
   `<LucideIcon :name="refIcon(commitRef)" class="git-history-graph-ref-icon" aria-hidden="true" />`],
  [/<span\s+:class="resolveFileIcon\(file\.status\)"\s*\/>/g, `<LucideIcon :name="resolveFileIcon(file.status)" />`],
  [/<span\s+:class="\[previewFileIcon,\s*'size-4'\]"\s*\/>/g, `<LucideIcon :name="previewFileIcon" class="size-4" />`],
  [/<span\s+:class="\[getIcon\(cat\.icon\),\s*'template-cat-svg'\]"\s*\/>/g, `<LucideIcon :name="getIcon(cat.icon)" class="template-cat-svg" />`],
  [/<span\s+:class="\[getIcon\(item\.icon\),\s*'template-snip-ic'\]"\s*\/>/g, `<LucideIcon :name="getIcon(item.icon)" class="template-snip-ic" />`],
];

const changed = []; const warn = [];

function writeFile(rel, content) {
  const abs = join(process.cwd(), rel);
  if (existsSync(abs) && readFileSync(abs, 'utf8') === content) return;
  if (WRITE) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content, 'utf8'); }
  changed.push(rel + (existsSync(abs) ? '' : ' (new)'));
}

function ensureInfra() {
  const uniq = [...new Set(NAMES)].sort();
  const reg = `// 由 scripts/codemod-iconify-phase2.mjs 生成,请勿手改。\n`
    + `import type { Component } from 'vue';\n`
    + `import {\n${uniq.map((n) => `\t${pascal(n)},`).join('\n')}\n} from '@lucide/vue';\n\n`
    + `export const lucideIconRegistry = {\n${uniq.map((n) => `\t'${n}': ${pascal(n)},`).join('\n')}\n} satisfies Record<string, Component>;\n\n`
    + `export type TLucideIconName = keyof typeof lucideIconRegistry;\n`;
  writeFile('src/components/ui/icon/lucide-icon-registry.ts', reg);
  const comp = `<script setup lang="ts">\nimport { computed } from 'vue';\nimport { lucideIconRegistry, type TLucideIconName } from './lucide-icon-registry';\n\n`
    + `const props = defineProps<{ name: TLucideIconName }>();\nconst component = computed(() => lucideIconRegistry[props.name] ?? null);\n</script>\n\n`
    + `<template>\n  <component :is="component" v-if="component" />\n</template>\n`;
  writeFile('src/components/ui/icon/LucideIcon.vue', comp);
}

function addImport(src) {
  if (src.includes(IMPORT)) return src;
  const m = src.match(/<script setup[^>]*>\s*\n/);
  return m ? src.replace(m[0], m[0] + IMPORT + '\n') : src;
}

function transform(rel, src) {
  let out = src;
  // T1: 模板里 :class 含 lucide token 的 span(三元/字面)-> <LucideIcon>,token 顺手去壳
  out = out.replace(/<span\b([^<]*?)\/>/g, (full, attrs) => {
    if (!/:class\s*=\s*"[^"]*icon-\[lucide--/.test(attrs)) return full;
    const na = attrs.replace(/:class(\s*=\s*)"([^"]*)"/, (mm, eq, val) => `:name${eq}"${dewrap(val)}"`);
    return `<LucideIcon${na}/>`;
  });
  // 特例:ThreadToolStatusIcon 的 running(把 animate-spin 从图标串挪进 tone)
  out = out.replace(
    /running:\s*\{\s*icon:\s*'icon-\[lucide--loader-circle\]\s+animate-spin',\s*tone:\s*'text-muted-foreground',/,
    `running: {\n    icon: 'loader-circle',\n    tone: 'text-muted-foreground animate-spin',`);
  // 特例:AiPromptInput 命令式 sparkles -> 内联 SVG
  out = out.replace(
    /icon\.className = 'ai-skill-pill__icon icon-\[lucide--sparkles\]';/,
    `icon.className = 'ai-skill-pill__icon';\n  icon.innerHTML =\n    ${SPARKLES_SVG};`);
  // 特例:ThreadToolStatusIcon.spec.ts 断言
  if (rel.endsWith('ThreadToolStatusIcon.spec.ts')) {
    out = out.replace(/(import ThreadToolStatusIcon[^\n]*\n)/,
      `$1import LucideIcon from '@/components/ui/icon/LucideIcon.vue';\n`);
    out = out.replace(/const icon = wrapper\.find\('span\[aria-hidden="true"\]'\);\s*\n\s*expect\(icon\.classes\(\)\)\.toContain\('icon-\[lucide--loader-circle\]'\);/,
      `const icon = wrapper.findComponent(LucideIcon);\n    expect(icon.props('name')).toBe('loader-circle');`);
    out = out.replace(/const icon = wrapper\.find\('span\[aria-hidden="true"\]'\);\s*\n\s*expect\(icon\.classes\(\)\)\.toContain\('icon-\[lucide--circle-alert\]'\);/,
      `const icon = wrapper.findComponent(LucideIcon);\n    expect(icon.props('name')).toBe('circle-alert');`);
  }
  // T3: 已知动态渲染位
  for (const [re, rep] of RENDER_RULES) out = out.replace(re, rep);
  // T2: 全局纯 token 去壳(map/computed 值)
  out = dewrap(out);
  // 引入 LucideIcon
  if (out.includes('<LucideIcon')) out = addImport(out);
  return out;
}

function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'node_modules') walk(p); continue; }
    if (!/\.(vue|ts|mts)$/.test(e)) continue;
    if (p.includes('lucide-icon-registry') || p.endsWith('LucideIcon.vue')) continue;
    const rel = p.replaceAll('\\', '/');
    const src = readFileSync(p, 'utf8');
    const out = transform(rel, src);
    if (out !== src) { changed.push(rel); if (WRITE) writeFileSync(p, out, 'utf8'); }
    // 残留扫描
    const left = (out.match(/icon-\[lucide--/g) || []).length;
    if (left) warn.push(`[残留 icon-token ${left}] ${rel}`);
    if (/TASK_ICON_MAP/.test(out) && !rel.endsWith('tool-icons.ts'))
      warn.push(`[需人工:TASK_ICON_MAP 渲染位] ${rel}`);
  }
}

console.log(`根目录: ${ROOT} | 模式: ${WRITE ? '写入(write)' : '预览(dry-run)'}`);
ensureInfra();
walk(join(process.cwd(), ROOT));
console.log(`改动文件: ${[...new Set(changed)].length}`);
[...new Set(changed)].forEach((c) => console.log('  ~ ' + c));
if (warn.length) { console.log('\n⚠️ 需复核:'); [...new Set(warn)].forEach((w) => console.log('  ' + w)); }