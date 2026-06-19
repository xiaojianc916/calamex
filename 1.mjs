// 1.mjs —— 仓库根目录: node 1.mjs ;之后 pnpm format && pnpm test
// v2: 兼容 Windows CRLF 工作区(匹配前归一化为 LF,写回保留原行尾)
import { readFileSync, writeFileSync } from 'node:fs';

let failed = false;
const detectEol = (raw) => (raw.includes('\r\n') ? '\r\n' : '\n');
const toLf = (raw) => raw.replace(/\r\n/g, '\n');

/** 唯一锚点替换:统一 LF 后匹配;命中≠1 则中止该文件。写回保留原 EOL。 */
function patch(rel, edits) {
  let raw;
  try { raw = readFileSync(rel, 'utf8'); }
  catch { console.error('✗ 读不到文件:', rel); failed = true; return; }
  const eol = detectEol(raw);
  let work = toLf(raw);
  const orig = work;
  for (const [find, replace] of edits) {
    const n = work.split(find).length - 1;
    if (n !== 1) {
      console.error(`✗ ${rel}: 锚点命中 ${n} 次(应为 1),跳过本文件。`);
      failed = true;
      return;
    }
    work = work.replace(find, () => replace);
  }
  if (work !== orig) {
    writeFileSync(rel, eol === '\r\n' ? work.replace(/\n/g, '\r\n') : work);
    console.log(`✓ patched ${rel} (EOL=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
  } else {
    console.log('· 无变化', rel);
  }
}

/** 整文件覆盖,保留原文件 EOL(新文件默认 LF)。 */
function rewrite(rel, content) {
  let eol = '\n';
  try { eol = detectEol(readFileSync(rel, 'utf8')); } catch {}
  writeFileSync(rel, eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content);
  console.log(`✓ rewrote ${rel} (EOL=${eol === '\r\n' ? 'CRLF' : 'LF'})`);
}

// ── 1) fuzzy-score.ts:删除 m<=2 的 indexOf 快速路径 ──
patch('src/utils/core/fuzzy-score.ts', [
  [
    `query.length;\n\n  // 短查询快速路径 (m <= 2): 直接用 indexOf 计算分数，跳过 DP 矩阵分配。\n  // 补全场景中多数 typed query ≤ 2 字符，此路径覆盖 ~70% 调用。\n  if (m <= 2) {\n    const idx = lowerText.indexOf(lowerQuery);\n    if (idx < 0) return null;\n    let score = SCORE_MATCH * m;\n    if (idx === 0) {\n      score += BONUS_BOUNDARY * m * BONUS_FIRST_CHAR_MULTIPLIER;\n    } else {\n      const prevClass = classifyChar(text[idx - 1]);\n      if (prevClass === 'whitespace' || prevClass === 'nonword') {\n        score += BONUS_BOUNDARY * m;\n      } else if (prevClass === 'lower' && classifyChar(text[idx]) === 'upper') {\n        score += BONUS_CAMEL * m;\n      }\n    }\n    return score;\n  }\n  const width = m + 1;`,
    `query.length;\n\n  const width = m + 1;`,
  ],
]);

// ── 2) aiAgent.ts:normalize 补回被裁剪的 token 明细字段 ──
patch('src/store/aiAgent.ts', [
  [
    `      inputTokenDetails?: {\n        cacheReadTokens?: number | null;\n        cacheCreationTokens?: number | null;\n      } | null;\n      outputTokenDetails?: {\n        reasoningTokens?: number | null;\n      } | null;`,
    `      inputTokenDetails?: {\n        noCacheTokens?: number | null;\n        cacheReadTokens?: number | null;\n        cacheCreationTokens?: number | null;\n        cacheWriteTokens?: number | null;\n      } | null;\n      outputTokenDetails?: {\n        textTokens?: number | null;\n        reasoningTokens?: number | null;\n      } | null;`,
  ],
  [
    `  inputTokenDetails: {\n    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,\n    cacheCreationTokens: usage?.inputTokenDetails?.cacheCreationTokens ?? 0,\n  },\n  outputTokenDetails: {\n    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,\n  },`,
    `  inputTokenDetails: {\n    noCacheTokens: usage?.inputTokenDetails?.noCacheTokens ?? 0,\n    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,\n    cacheCreationTokens: usage?.inputTokenDetails?.cacheCreationTokens ?? 0,\n    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,\n  },\n  outputTokenDetails: {\n    textTokens: usage?.outputTokenDetails?.textTokens ?? 0,\n    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,\n  },`,
  ],
]);

// ── 3) useAiAssistant.ts:补 errorMessage 别名(保留 error)──
patch('src/composables/ai/useAiAssistant.ts', [
  [
    `    isSending,\n    error: errorMessage,\n    providerLabel,`,
    `    isSending,\n    error: errorMessage,\n    errorMessage,\n    providerLabel,`,
  ],
]);

// ── 4) app-tooltip.ts:重写对齐 spec(已成功,这里保持幂等)──
rewrite(
  'src/utils/window/app-tooltip.ts',
  [
    `export interface IAppTooltipSystem {`,
    `  dispose: () => void;`,
    `}`,
    ``,
    `const TOOLTIP_DELAY_MS = 3000;`,
    `const TOOLTIP_ELEMENT_ID = 'app-global-tooltip';`,
    `const TOOLTIP_VISIBLE_CLASS = 'is-visible';`,
    `const TOOLTIP_CLEANUP_KEY = '__SH_APP_TOOLTIP_CLEANUP__';`,
    `const TOOLTIP_TARGET_SELECTOR = '[data-app-tooltip], [data-tooltip], [aria-label], [title]';`,
    `const TOOLTIP_TEXT_ATTRIBUTES = [`,
    `  'data-app-tooltip',`,
    `  'data-tooltip',`,
    `  'aria-label',`,
    `  'title',`,
    `] as const;`,
    ``,
    `type TTooltipCleanupHost = Record<string, (() => void) | undefined>;`,
    ``,
    `const resolveTooltipText = (target: Element): string => {`,
    `  for (const attr of TOOLTIP_TEXT_ATTRIBUTES) {`,
    `    const value = target.getAttribute(attr);`,
    `    if (value) return value;`,
    `  }`,
    `  return '';`,
    `};`,
    ``,
    `export const initAppTooltipSystem = (): IAppTooltipSystem => {`,
    `  const tooltipElement = document.createElement('div');`,
    `  tooltipElement.id = TOOLTIP_ELEMENT_ID;`,
    `  tooltipElement.setAttribute('role', 'tooltip');`,
    `  tooltipElement.style.position = 'fixed';`,
    `  tooltipElement.style.pointerEvents = 'none';`,
    `  tooltipElement.style.zIndex = '9999';`,
    `  document.body.appendChild(tooltipElement);`,
    ``,
    `  let hoverTarget: Element | null = null;`,
    `  let hoverTimer: ReturnType<typeof setTimeout> | null = null;`,
    `  let pointerMoveAttached = false;`,
    ``,
    `  const clearHoverTimer = (): void => {`,
    `    if (hoverTimer !== null) {`,
    `      clearTimeout(hoverTimer);`,
    `      hoverTimer = null;`,
    `    }`,
    `  };`,
    ``,
    `  const setPosition = (event: PointerEvent | MouseEvent): void => {`,
    `    tooltipElement.style.left = String(event.clientX + 10) + 'px';`,
    `    tooltipElement.style.top = String(event.clientY + 10) + 'px';`,
    `  };`,
    ``,
    `  function handlePointerMove(event: PointerEvent): void {`,
    `    setPosition(event);`,
    `  }`,
    ``,
    `  const attachPointerMove = (): void => {`,
    `    if (!pointerMoveAttached) {`,
    `      document.addEventListener('pointermove', handlePointerMove);`,
    `      pointerMoveAttached = true;`,
    `    }`,
    `  };`,
    ``,
    `  const detachPointerMove = (): void => {`,
    `    if (pointerMoveAttached) {`,
    `      document.removeEventListener('pointermove', handlePointerMove);`,
    `      pointerMoveAttached = false;`,
    `    }`,
    `  };`,
    ``,
    `  const show = (target: Element, event?: PointerEvent | MouseEvent): void => {`,
    `    const text = resolveTooltipText(target);`,
    `    if (!text) return;`,
    ``,
    `    tooltipElement.textContent = text;`,
    `    tooltipElement.classList.add(TOOLTIP_VISIBLE_CLASS);`,
    ``,
    `    if (event) {`,
    `      setPosition(event);`,
    `    }`,
    `  };`,
    ``,
    `  const hide = (): void => {`,
    `    clearHoverTimer();`,
    `    hoverTarget = null;`,
    `    tooltipElement.classList.remove(TOOLTIP_VISIBLE_CLASS);`,
    `    tooltipElement.textContent = '';`,
    `    detachPointerMove();`,
    `  };`,
    ``,
    `  const handlePointerOver = (event: PointerEvent): void => {`,
    `    const target =`,
    `      event.target instanceof Element ? event.target.closest(TOOLTIP_TARGET_SELECTOR) : null;`,
    `    if (!target) return;`,
    ``,
    `    hoverTarget = target;`,
    `    attachPointerMove();`,
    `    setPosition(event);`,
    `    clearHoverTimer();`,
    `    hoverTimer = setTimeout(() => {`,
    `      if (hoverTarget === target) {`,
    `        show(target, event);`,
    `      }`,
    `    }, TOOLTIP_DELAY_MS);`,
    `  };`,
    ``,
    `  const handlePointerOut = (): void => {`,
    `    hide();`,
    `  };`,
    ``,
    `  const handleFocusIn = (event: FocusEvent): void => {`,
    `    const target =`,
    `      event.target instanceof Element ? event.target.closest(TOOLTIP_TARGET_SELECTOR) : null;`,
    `    if (!target) return;`,
    `    show(target);`,
    `  };`,
    ``,
    `  const handleFocusOut = (): void => {`,
    `    hide();`,
    `  };`,
    ``,
    `  document.addEventListener('pointerover', handlePointerOver);`,
    `  document.addEventListener('pointerout', handlePointerOut);`,
    `  document.addEventListener('focusin', handleFocusIn);`,
    `  document.addEventListener('focusout', handleFocusOut);`,
    ``,
    `  const dispose = (): void => {`,
    `    hide();`,
    `    document.removeEventListener('pointerover', handlePointerOver);`,
    `    document.removeEventListener('pointerout', handlePointerOut);`,
    `    document.removeEventListener('focusin', handleFocusIn);`,
    `    document.removeEventListener('focusout', handleFocusOut);`,
    `    tooltipElement.remove();`,
    `    const host = globalThis as unknown as TTooltipCleanupHost;`,
    `    if (host[TOOLTIP_CLEANUP_KEY]) {`,
    `      host[TOOLTIP_CLEANUP_KEY] = undefined;`,
    `    }`,
    `  };`,
    ``,
    `  (globalThis as unknown as TTooltipCleanupHost)[TOOLTIP_CLEANUP_KEY] = dispose;`,
    ``,
    `  return { dispose };`,
    `};`,
    ``,
  ].join('\n'),
);

if (failed) {
  console.error('\n仍有文件锚点不匹配 → 把该文件最新内容发我重新校锚点。');
  process.exitCode = 1;
} else {
  console.log('\n全部完成。接着: pnpm format && pnpm test');
}