// find-old-symbol.mjs  —  run: node find-old-symbol.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'src');
const OLD_RE = /collectConversationRuntimeEvents\b/;           // matches ONLY the old name
const NEW_NAME = 'collectConversationRuntimeEventsFromEntries'; // the renamed export
const SKIP = new Set(['node_modules', 'dist', '.git', 'target', 'src-tauri']);

const oldHits = [];
const newHits = [];

const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP.has(name)) walk(full);
      continue;
    }
    if (!/\.(ts|tsx|vue|mts|cts|js|mjs)$/.test(name)) continue;
    readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
      if (line.includes(NEW_NAME)) newHits.push(`${full}:${i + 1}: ${line.trim()}`);
      else if (OLD_RE.test(line)) oldHits.push(`${full}:${i + 1}: ${line.trim()}`);
    });
  }
};

walk(ROOT);

console.log(`OLD name "collectConversationRuntimeEvents" — ${oldHits.length} hit(s):`);
oldHits.forEach((h) => console.log('  ' + h));
console.log(`\nNEW name "${NEW_NAME}" — ${newHits.length} hit(s):`);
newHits.forEach((h) => console.log('  ' + h));

if (oldHits.length === 0) {
  console.log(
    '\n=> No stale references on disk. Fully RESTART the dev server (stop pnpm dev, then `pnpm dev`). ' +
      'Vite HMR caches renamed cross-module exports and throws exactly this error until a clean restart.',
  );
}