import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), '../..');
process.chdir(repoRoot);

await import('../../scripts/fix-use-ai-assistant-acp-spec.mjs');
