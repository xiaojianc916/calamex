/**
 * check-router-disabled.ts
 * vue-router 已是常驻启用的最小路由壳（App.vue 唯一渲染入口 + 主窗口 reveal 握手）。
 * 规则：main.ts 出现 app.use(router) 时，router/index.ts 必须标记 @status: active，
 * 且存在一份 accepted 的启用 ADR；否则 fail（R-18.2.1 / R-18.2.3）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CheckResult, ROOT, printResult, summarize } from './guard-utils.js';

const MAIN_TS = path.join(ROOT, 'src/main.ts');
const ROUTER_INDEX = path.join(ROOT, 'src/router/index.ts');
const ADR_ROUTER_ACTIVE = path.join(ROOT, 'docs/architecture/ADR-0008-router-active-shell.md');

const results: CheckResult[] = [];

const readFileIfExists = (filePath: string): string | null =>
  fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;

if (!fs.existsSync(MAIN_TS)) {
  results.push({
    severity: 'WARN',
    message: 'src/main.ts 不存在，跳过路由检查',
    file: 'src/main.ts',
  });
} else {
  const mainContent = fs.readFileSync(MAIN_TS, 'utf-8');
  const hasRouterUse = /app\s*\.\s*use\s*\(\s*router\s*\)/i.test(mainContent);
  const routerIndexContent = readFileIfExists(ROUTER_INDEX) ?? '';
  const routerHeader = routerIndexContent.split('\n').slice(0, 5).join('\n');
  const isRouterActive = /@status:\s*active/i.test(routerHeader);
  const activeAdrContent = readFileIfExists(ADR_ROUTER_ACTIVE);
  const hasAcceptedActiveAdr =
    activeAdrContent !== null &&
    (/Status.*accepted/i.test(activeAdrContent) || /\u72b6\u6001.*accepted/i.test(activeAdrContent));

  if (hasRouterUse) {
    if (isRouterActive && hasAcceptedActiveAdr) {
      results.push({
        severity: 'PASS',
        message: 'main.ts 中存在 app.use(router)，且已由 ADR-0008 明确启用为最小路由壳',
        file: 'src/main.ts',
      });
    } else if (!isRouterActive) {
      results.push({
        severity: 'ERROR',
        message: 'main.ts 中存在 app.use(router)，但 router/index.ts 未标记 @status: active',
        file: 'src/router/index.ts',
        detail: '请在 router/index.ts 头部声明 @status: active，并补充对应启用 ADR',
      });
    } else {
      results.push({
        severity: 'ERROR',
        message: 'main.ts 中存在 app.use(router)，但缺少 accepted 的启用 ADR（R-18.2.3）',
        file: 'src/main.ts',
        detail: `启用路由需有 accepted 的 ADR：${path.relative(ROOT, ADR_ROUTER_ACTIVE)}，经 Code Owner 批准`,
      });
    }
  } else if (isRouterActive) {
    results.push({
      severity: 'WARN',
      message: 'router 已标记 active，但 main.ts 未注册 app.use(router)',
      file: 'src/main.ts',
    });
  } else {
    results.push({
      severity: 'PASS',
      message: 'main.ts 中无 app.use(router)，路由保持休眠状态',
      file: 'src/main.ts',
    });
  }
}

results.forEach(printResult);
const hasError = summarize('check-router-disabled', results);
process.exit(hasError ? 1 : 0);
