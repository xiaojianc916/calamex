#!/usr/bin/env node
/**
 * Codemod: migrate unplugin-icons component imports (`~icons/<set>/<name>`)
 * to @iconify/tailwind4 CSS-mask classes (`icon-[lucide--arrow-left]`, suffix form `<set>--<name>`).
 *
 * Why: unplugin-icons compiles every icon SVG into a Vue component at build time
 * (the dominant cost in our build's plugin timings). @iconify/tailwind4 instead
 * inlines each used icon's SVG into a single CSS mask utility, so the heavy
 * per-icon compilation disappears once unplugin-icons is fully removed.
 *
 * Usage:
 *   node scripts/migrate-icons-to-mask.mjs            # dry-run, report only (default)
 *   node scripts/migrate-icons-to-mask.mjs --write     # apply changes in place
 *   node scripts/migrate-icons-to-mask.mjs --dir src   # custom root (default: src)
 *
 * Per .vue file it will:
 *   - find default imports from '~icons/<set>/<name>' or 'virtual:icons/<set>/<name>'
 *   - replace template tag usages `<Local .../>` and `<Local>...</Local>`
 *     (PascalCase and kebab-case) with `<span class="icon-[lucide--arrow-left] ...">`,
 *     merging any existing static `class` and preserving :class / style / @click / v-if / etc.
 *   - remove the now-unused icon import
 *
 * It will NOT touch (and will report as "manual review"):
 *   - icons referenced as identifiers: dynamic `<component :is="X"/>`, passed as a
 *     prop like `:icon="X"`, or used inside <script> / render functions
 *   - icon imports inside .ts/.tsx/.js/.jsx files
 *   Tailwind only detects STATIC class names, so dynamic icon selection must be
 *   safelisted by hand, e.g. in your CSS:
 *     @source inline("icon-[lucide--{search,x,check,trash}]");
 *
 * Review the dry-run output and the resulting git diff before committing.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const dirArgIdx = args.indexOf('--dir')
const ROOT = dirArgIdx !== -1 && args[dirArgIdx + 1] ? args[dirArgIdx + 1] : 'src'

// Matches: import Foo from '~icons/lucide/arrow-left'  (also virtual:icons/, optional ?query, optional ;)
const IMPORT_RE =
  /import\s+(\w+)\s+from\s*['"](?:~icons|virtual:icons)\/([a-z0-9]+)\/([a-z0-9-]+)(?:\?[^'"]*)?['"]\s*;?[ \t]*\r?\n?/g

const SOURCE_EXTS = new Set(['.vue', '.ts', '.tsx', '.js', '.jsx'])

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const toKebab = (s) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()

// Merge the mask class into an attribute string, preserving everything else.
function injectClass(attrs, maskClass) {
  const classRe = /(\sclass\s*=\s*)(["'])([\s\S]*?)\2/
  const m = attrs.match(classRe)
  if (m) {
    const merged = `${maskClass} ${m[3]}`.trim()
    return attrs.replace(classRe, `${m[1]}${m[2]}${merged}${m[2]}`)
  }
  const trimmed = attrs.replace(/\s+$/, '')
  return `${trimmed} class="${maskClass}"`
}

function replaceTag(content, tag, maskClass) {
  const t = escapeRe(tag)
  let count = 0
  // self-closing: <Tag ... />
  content = content.replace(new RegExp(`<${t}((?:\\s[^>]*?)?)\\/>`, 'g'), (_m, attrs) => {
    count++
    return `<span${injectClass(attrs, maskClass)} />`
  })
  // paired: <Tag ...> ... </Tag>
  content = content.replace(
    new RegExp(`<${t}((?:\\s[^>]*?)?)>([\\s\\S]*?)<\\/${t}>`, 'g'),
    (_m, attrs, inner) => {
      count++
      return `<span${injectClass(attrs, maskClass)}>${inner}</span>`
    },
  )
  return { content, count }
}

function countMatches(text, re) {
  return (text.match(re) || []).length
}

function processFile(file, text) {
  const imports = [...text.matchAll(IMPORT_RE)]
  if (imports.length === 0) return null

  const isVue = extname(file) === '.vue'
  const hasTemplate = isVue && /<template[\s>]/.test(text)
  let content = text
  const migrated = []
  const manual = []

  for (const im of imports) {
    const [full, local, set, name] = im
    const maskClass = `icon-[${set}--${name}]`

    if (!hasTemplate) {
      manual.push({ local, maskClass, reason: 'no <template> (used in script / render fn / .ts file)' })
      continue
    }

    const esc = escapeRe(local)
    const totalRefs = countMatches(content, new RegExp(`\\b${esc}\\b`, 'g'))
    const selfClose = countMatches(content, new RegExp(`<${esc}(?:\\s[^>]*?)?\\/>`, 'g'))
    const paired = countMatches(content, new RegExp(`<${esc}(?:\\s[^>]*?)?>[\\s\\S]*?<\\/${esc}>`, 'g'))
    const localTagWords = selfClose + paired * 2
    // 1 reference is the import binding itself; the rest beyond tag usages are
    // identifier references we must not break (dynamic :is, prop passing, etc.)
    const nonTagRefs = totalRefs - 1 - localTagWords
    if (nonTagRefs > 0) {
      manual.push({ local, maskClass, reason: 'referenced as identifier (dynamic :is / passed as prop / used in script)' })
      continue
    }

    let total = 0
    let r = replaceTag(content, local, maskClass)
    content = r.content
    total += r.count
    const kebab = toKebab(local)
    if (kebab !== local) {
      r = replaceTag(content, kebab, maskClass)
      content = r.content
      total += r.count
    }

    if (total === 0) {
      manual.push({ local, maskClass, reason: 'import present but no template tag usage found' })
      continue
    }

    content = content.replace(full, '')
    migrated.push({ local, maskClass, count: total })
  }

  return { content, migrated, manual, changed: content !== text }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (SOURCE_EXTS.has(extname(p))) out.push(p)
  }
  return out
}

function main() {
  const files = walk(ROOT)
  let migratedTotal = 0
  let manualTotal = 0
  let changedFiles = 0
  const manualReport = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const res = processFile(file, text)
    if (!res) continue
    if (res.migrated.length) {
      changedFiles++
      console.log(`\n${file}`)
      for (const m of res.migrated) {
        migratedTotal += m.count
        console.log(`  ✓ ${m.local} -> ${m.maskClass}  (${m.count} usage${m.count > 1 ? 's' : ''})`)
      }
    }
    for (const m of res.manual) {
      manualTotal++
      manualReport.push(`  ⚠ ${file}: ${m.local} -> ${m.maskClass}  [${m.reason}]`)
    }
    if (WRITE && res.changed) writeFileSync(file, res.content, 'utf8')
  }

  if (manualReport.length) {
    console.log(`\n── Manual review (${manualTotal}) ──`)
    for (const line of manualReport) console.log(line)
    console.log('\n  These need a static safelist or a manual rewrite. Example CSS:')
    console.log('    @source inline("icon-[lucide--{name1,name2}]");')
  }

  console.log(`\n── Summary ──`)
  console.log(`  files scanned:        ${files.length}`)
  console.log(`  files auto-migrated:  ${changedFiles}`)
  console.log(`  usages auto-migrated: ${migratedTotal}`)
  console.log(`  manual-review items:  ${manualTotal}`)
  console.log(WRITE ? '\n  Mode: --write (files updated)' : '\n  Mode: dry-run (no files changed). Re-run with --write to apply.')
  if (manualTotal === 0 && WRITE) {
    console.log('\n  No manual items — safe to remove unplugin-icons next (vite.config.ts + shims-icons.d.ts).')
  }
}

main()
