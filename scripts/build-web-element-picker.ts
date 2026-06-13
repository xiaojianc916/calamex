import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(currentDir, '..');
const entry = path.join(workspaceRoot, 'src', 'content', 'web-element-picker.ts');
const outDir = path.join(workspaceRoot, 'src-tauri', 'assets');
const outFile = 'web-element-picker.generated.js';

await build({
  configFile: false,
  root: workspaceRoot,
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: false,
    minify: 'esbuild',
    target: 'chrome120',
    lib: {
      entry,
      formats: ['iife'],
      name: '__calamexWebElementPicker',
      fileName: () => outFile,
    },
  },
});

console.log(`Bundled web element picker -> ${path.join('src-tauri', 'assets', outFile)}`);
