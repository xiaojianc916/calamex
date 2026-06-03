import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ToolKind {
  kind: string;
  patterns: string[];
}

interface ToolEntry {
  id: string;
  title: string;
  layer: string;
  capability: string;
  approval: string;
  argsSchema?: unknown;
  resultSchema?: unknown;
  [key: string]: unknown;
}

interface ToolsManifest {
  schemaVersion: number;
  toolKinds: ToolKind[];
  tools: ToolEntry[];
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(rootDir, 'schemas', 'ai-tools-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ToolsManifest;

const generatedHeader = '/* eslint-disable */\n// 本文件由 scripts/gen-tools.ts 生成，请勿手改。\n';
const rustHeader = '// 本文件由 scripts/gen-tools.ts 生成，请勿手改。\n#![allow(dead_code)]\n';

const assertStringArray = (value: unknown, label: string): void => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} 必须是字符串数组。`);
  }
};

if (!Number.isInteger(manifest.schemaVersion)) {
  throw new Error('schemaVersion 必须是整数。');
}
if (!Array.isArray(manifest.toolKinds) || !Array.isArray(manifest.tools)) {
  throw new Error('manifest 必须包含 toolKinds 和 tools。');
}

for (const item of manifest.toolKinds) {
  if (typeof item.kind !== 'string') {
    throw new Error('toolKinds.kind 必须是字符串。');
  }
  assertStringArray(item.patterns, `toolKinds.${item.kind}.patterns`);
}

for (const tool of manifest.tools) {
  for (const key of ['id', 'title', 'layer', 'capability', 'approval']) {
    if (typeof tool[key] !== 'string') {
      throw new Error(`tools.${tool.id ?? '<unknown>'}.${key} 必须是字符串。`);
    }
  }
}

const toolKindUnion = manifest.toolKinds.map((item) => `'${item.kind}'`).concat(`'system'`).join(' | ');
const toolKindsLiteral = JSON.stringify(manifest.toolKinds, null, 2)
  .replace(/"kind":/g, 'kind:')
  .replace(/"patterns":/g, 'patterns:');
const toolsLiteral = JSON.stringify(manifest.tools, null, 2)
  .replace(/"id":/g, 'id:')
  .replace(/"title":/g, 'title:')
  .replace(/"layer":/g, 'layer:')
  .replace(/"capability":/g, 'capability:')
  .replace(/"approval":/g, 'approval:')
  .replace(/"argsSchema":/g, 'argsSchema:')
  .replace(/"resultSchema":/g, 'resultSchema:');

const frontendOutput = `${generatedHeader}
export type TAiRuntimeToolKind = ${toolKindUnion};

interface IToolKindMatcher {
  kind: TAiRuntimeToolKind;
  patterns: RegExp[];
}

export interface IAiRuntimeToolManifestEntry {
  id: string;
  title: string;
  layer: 'rust' | 'sidecar' | 'frontend';
  capability: string;
  approval: 'none' | 'required';
  argsSchema: unknown;
  resultSchema: unknown;
}

const TOOL_KIND_MATCHERS: readonly IToolKindMatcher[] = ${toolKindsLiteral}.map((item) => ({
  kind: item.kind as TAiRuntimeToolKind,
  patterns: item.patterns.map((pattern) => new RegExp(pattern, 'u')),
}));

export const AI_RUNTIME_TOOLS_MANIFEST = ${toolsLiteral} as readonly IAiRuntimeToolManifestEntry[];

export const normalizeRuntimeToolName = (toolName: string): string =>
  toolName
    .replace(/^mcp\\./u, '')
    .replace(/^functions\\./u, '')
    .trim();

export const classifyRuntimeToolKind = (toolName: string): TAiRuntimeToolKind => {
  const normalized = normalizeRuntimeToolName(toolName).toLowerCase();

  for (const matcher of TOOL_KIND_MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(normalized))) {
      return matcher.kind;
    }
  }

  return 'system';
};
`;

const sidecarOutput = `${generatedHeader}
export interface IAiRuntimeToolManifestEntry {
  id: string;
  title: string;
  layer: 'rust' | 'sidecar' | 'frontend';
  capability: string;
  approval: 'none' | 'required';
  argsSchema: unknown;
  resultSchema: unknown;
}

export const AI_TOOLS_MANIFEST_SCHEMA_VERSION = ${manifest.schemaVersion} as const;
export const AI_RUNTIME_TOOLS_MANIFEST = ${toolsLiteral} as readonly IAiRuntimeToolManifestEntry[];
`;

const rustTools = manifest.tools
  .map((tool) => `    AiRuntimeToolManifestEntry {
        id: ${JSON.stringify(tool.id)},
        title: ${JSON.stringify(tool.title)},
        layer: ${JSON.stringify(tool.layer)},
        capability: ${JSON.stringify(tool.capability)},
        approval: ${JSON.stringify(tool.approval)},
    }`)
  .join(',\n');

const rustOutput = `${rustHeader}
#[derive(Debug, Clone, Copy)]
pub struct AiRuntimeToolManifestEntry {
    pub id: &'static str,
    pub title: &'static str,
    pub layer: &'static str,
    pub capability: &'static str,
    pub approval: &'static str,
}

pub const AI_TOOLS_MANIFEST_SCHEMA_VERSION: u32 = ${manifest.schemaVersion};
pub const AI_RUNTIME_TOOLS_MANIFEST: &[AiRuntimeToolManifestEntry] = &[
${rustTools}
];
`;

const writeGenerated = (relativePath: string, content: string): void => {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
};

writeGenerated('src/constants/ai/runtime-tools.generated.ts', frontendOutput);
writeGenerated('agent-sidecar/src/tools/generated.ts', sidecarOutput);
writeGenerated('src-tauri/src/commands/ai/tools_generated.rs', rustOutput);
