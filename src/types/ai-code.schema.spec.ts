import { parseFenceInfo } from '@/services/modules/ai-code-detect';
import { renderAiMarkdown } from '@/services/modules/ai-render';
import { aiCodeBlockSchema, fenceInfoSchema } from '@/types/ai-code.schema';
import { describe, expect, it } from 'vitest';

describe('AI Chat code rendering', () => {
  it('按 fence 显式标注识别语言', () => {
    const fence = parseFenceInfo('typescript', 'const a = 1');

    expect(fenceInfoSchema.parse(fence).lang).toBe('ts');
    expect(fence.detection.source).toBe('fence');
  });

  it('非法 fence info 降级为 plaintext', () => {
    const fence = parseFenceInfo('typescript<script>', 'const a = 1');

    expect(fence.lang).toBe('plaintext');
    expect(fence.detection.source).toBe('fallback');
  });

  it('通过 shebang 识别 shell', () => {
    const fence = parseFenceInfo('', '#!/usr/bin/env bash\necho ok');

    expect(fence.lang).toBe('bash');
    expect(fence.detection.source).toBe('shebang');
  });

  it('解析 path meta 为可应用候选', () => {
    const fence = parseFenceInfo('sh path=src/main.sh:12-14', 'echo ok');

    expect(fence.meta.filePath).toBe('src/main.sh');
    expect(fence.meta.startLine).toBe(12);
    expect(fence.meta.endLine).toBe(14);
    expect(fence.meta.isApplyCandidate).toBe(true);
  });

  it('把 fence 渲染为结构化代码块而不是 raw html', () => {
    const segments = renderAiMarkdown('m1', '说明\n```sh\necho ok\n```');
    const codeSegment = segments.find((segment) => segment.kind === 'code');

    expect(codeSegment?.kind).toBe('code');
    if (codeSegment?.kind === 'code') {
      expect(aiCodeBlockSchema.parse(codeSegment.block).fence.lang).toBe('sh');
    }
  });

  it('diff fence 标记为专用渲染与可应用候选', () => {
    const segments = renderAiMarkdown('m1', '```diff\n@@ -1 +1\n-foo\n+bar\n```');
    const codeSegment = segments.find((segment) => segment.kind === 'code');

    expect(codeSegment?.kind).toBe('code');
    if (codeSegment?.kind === 'code') {
      expect(codeSegment.block.fence.lang).toBe('diff');
      expect(codeSegment.block.fence.meta.isDiff).toBe(true);
      expect(codeSegment.block.fence.meta.isApplyCandidate).toBe(true);
    }
  });

  it('净化 markdown HTML 注入', () => {
    const segments = renderAiMarkdown('m1', '<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    const html = segments.map((segment) => (segment.kind === 'html' ? segment.html : '')).join('');

    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
  });
});
