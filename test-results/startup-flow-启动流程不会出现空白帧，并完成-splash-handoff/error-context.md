# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: startup-flow.spec.ts >> 启动流程不会出现空白帧，并完成 splash handoff
- Location: e2e\startup-flow.spec.ts:59:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('workbench-root')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for getByTestId('workbench-root')

```

# Page snapshot

```yaml
- alert [ref=e5]:
  - generic [ref=e10]:
    - img [ref=e11]
    - generic [ref=e14]: system-loader.js
  - generic [ref=e15]:
    - generic [ref=e16]: "[error] Vue 组件渲染错误"
    - generic [ref=e17]: "[message] Cannot read properties of undefined (reading 'transformCallback')"
    - generic [ref=e19]: "TypeError: Cannot read properties of undefined (reading 'transformCallback') at transformCallback (http://127.0.0.1:1420/node_modules/.vite/deps/core-Du8RhivC.js?v=21591596:90:36) at listen (http://127.0.0.1:1420/node_modules/.vite/deps/@tauri-apps_api_event.js?v=21591596:74:12) at http://127.0.0.1:1420/src/terminal/session.ts:229:5 at TerminalSession.registerEventListeners (http://127.0.0.1:1420/src/terminal/session.ts:246:5) at http://127.0.0.1:1420/src/composables/useIntegratedTerminal.ts:80:17 at http://127.0.0.1:1420/node_modules/.vite/deps/vue.runtime.esm-bundler-DPTzzImu.js?v=21591596:3783:87 at callWithErrorHandling (http://127.0.0.1:1420/node_modules/.vite/deps/vue.runtime.esm-bundler-DPTzzImu.js?v=21591596:1874:17) at callWithAsyncErrorHandling (http://127.0.0.1:1420/node_modules/.vite/deps/vue.runtime.esm-bundler-DPTzzImu.js?v=21591596:1881:15) at hook.__weh.hook.__weh (http://127.0.0.1:1420/node_modules/.vite/deps/vue.runtime.esm-bundler-DPTzzImu.js?v=21591596:3772:16) at flushPostFlushCbs (http://127.0.0.1:1420/node_modules/.vite/deps/vue.runtime.esm-bundler-DPTzzImu.js?v=21591596:2006:25)"
  - progressbar [ref=e21]
  - generic [ref=e23]:
    - generic [ref=e24]: "!"
    - generic [ref=e25]: 启动失败，请查看错误日志。
```

# Test source

```ts
  1  | import { expect, test } from '@playwright/test';
  2  | 
  3  | type IStartupSnapshot = {
  4  |     t: number;
  5  |     bootstrap: boolean;
  6  |     splash: boolean;
  7  |     appVisible: boolean;
  8  |     workbench: boolean;
  9  |     veil: boolean;
  10 | };
  11 | 
  12 | declare global {
  13 |     interface Window {
  14 |         __SH_STARTUP_TRACE__?: IStartupSnapshot[];
  15 |     }
  16 | }
  17 | 
  18 | test.beforeEach(async ({ page }) => {
  19 |     await page.addInitScript(() => {
  20 |         const trace: IStartupSnapshot[] = [];
  21 | 
  22 |         const snapshot = (): void => {
  23 |             trace.push({
  24 |                 t: performance.now(),
  25 |                 bootstrap: Boolean(document.getElementById('bootstrap-splash')),
  26 |                 splash: Boolean(document.querySelector('[data-testid="splash-screen"]')),
  27 |                 appVisible: Boolean(document.querySelector('[data-testid="app-content-entry"].is-visible')),
  28 |                 workbench: Boolean(document.querySelector('[data-testid="workbench-root"]')),
  29 |                 veil: Boolean(document.querySelector('[data-testid="startup-veil"]')),
  30 |             });
  31 | 
  32 |             if (trace.length > 2_000) {
  33 |                 trace.shift();
  34 |             }
  35 |         };
  36 | 
  37 |         window.__SH_STARTUP_TRACE__ = trace;
  38 | 
  39 |         document.addEventListener('DOMContentLoaded', snapshot, { once: true });
  40 | 
  41 |         new MutationObserver(snapshot).observe(document.documentElement, {
  42 |             subtree: true,
  43 |             childList: true,
  44 |             attributes: true,
  45 |             attributeFilter: ['class', 'style'],
  46 |         });
  47 | 
  48 |         const sample = (): void => {
  49 |             snapshot();
  50 |             if (performance.now() < 10_000) {
  51 |                 window.requestAnimationFrame(sample);
  52 |             }
  53 |         };
  54 | 
  55 |         window.requestAnimationFrame(sample);
  56 |     });
  57 | });
  58 | 
  59 | test('启动流程不会出现空白帧，并完成 splash handoff', async ({ page }) => {
  60 |     await page.goto('/');
  61 | 
> 62 |     await expect(page.getByTestId('workbench-root')).toBeVisible({ timeout: 10_000 });
     |                                                      ^ Error: expect(locator).toBeVisible() failed
  63 |     await expect(page.getByTestId('splash-screen')).toHaveCount(0, { timeout: 10_000 });
  64 |     await expect(page.locator('#bootstrap-splash')).toHaveCount(0);
  65 |     await expect(page.getByTestId('startup-veil')).toHaveCount(0);
  66 |     await expect(page.getByTestId('app-content-entry')).toHaveClass(/is-visible/);
  67 | 
  68 |     const trace = await page.evaluate(() => window.__SH_STARTUP_TRACE__ ?? []);
  69 | 
  70 |     expect(trace.length).toBeGreaterThan(0);
  71 | 
  72 |     const firstRelevantIndex = trace.findIndex(
  73 |         (entry) => entry.bootstrap || entry.splash || entry.appVisible || entry.workbench,
  74 |     );
  75 | 
  76 |     expect(firstRelevantIndex).toBeGreaterThanOrEqual(0);
  77 | 
  78 |     const lifecycle = trace.slice(firstRelevantIndex);
  79 | 
  80 |     expect(lifecycle.some((entry) => entry.bootstrap)).toBeTruthy();
  81 |     expect(lifecycle.some((entry) => entry.splash)).toBeTruthy();
  82 |     expect(lifecycle.some((entry) => entry.workbench)).toBeTruthy();
  83 | 
  84 |     const blankFrame = lifecycle.find(
  85 |         (entry) => !entry.bootstrap && !entry.splash && !entry.appVisible && !entry.veil,
  86 |     );
  87 | 
  88 |     expect(blankFrame).toBeUndefined();
  89 | 
  90 |     const finalSnapshot = lifecycle[lifecycle.length - 1];
  91 | 
  92 |     expect(finalSnapshot?.bootstrap).toBeFalsy();
  93 |     expect(finalSnapshot?.splash).toBeFalsy();
  94 |     expect(finalSnapshot?.appVisible).toBeTruthy();
  95 | });
```