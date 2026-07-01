// 1.mjs — R3: 移除 vue-router(单视图直接挂载 ShellWorkbenchView)+ 修正 App.spec.ts
// 写前全仓扫描,越界即中止(不写不删);CRLF 安全;可重复执行(幂等)。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const p = (rel) => path.join(ROOT, rel.split('/').join(path.sep));
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

const die = (msg) => {
  console.error(`\n✗ ${msg}`);
  console.error('  已中止:未写入任何文件、未删除任何文件。\n');
  process.exit(1);
};

// ---- EOL helpers ----
const detectEol = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toLf = (s) => s.replace(/\r\n/g, '\n');
const readText = (rp) => {
  const abs = p(rp);
  if (!fs.existsSync(abs)) die(`未找到文件:${rp}`);
  return fs.readFileSync(abs, 'utf8');
};

// ---- 单锚点替换(多命中即中止;可选锚点不命中仅告警) ----
const replaceIn = (srcLf, oldLf, newLf, label, { optional = false } = {}) => {
  const first = srcLf.indexOf(oldLf);
  if (first === -1) {
    if (optional) {
      console.warn(`  · 跳过(未命中,可选):${label}`);
      return srcLf;
    }
    die(`未找到锚点「${label}」——文件当前内容与预期不符,请把对应片段贴给我核对`);
  }
  if (srcLf.indexOf(oldLf, first + oldLf.length) !== -1) {
    die(`锚点「${label}」命中多处,拒绝盲替。请贴文件片段核对`);
  }
  return srcLf.slice(0, first) + newLf + srcLf.slice(first + oldLf.length);
};

// ---- 遍历 src/ 做扫描 ----
const SKIP = new Set(['node_modules', '.git', 'dist', 'target', '.next', 'coverage', 'gen']);
const walk = (dirAbs, out = []) => {
  for (const name of fs.readdirSync(dirAbs)) {
    if (SKIP.has(name)) continue;
    const abs = path.join(dirAbs, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
};

const srcRoot = p('src');
if (!fs.existsSync(srcRoot)) die('未找到 src/ 目录,请在仓库根目录运行 node 1.mjs');
const pkgRaw0 = readText('package.json');
if (!/"name"\s*:\s*"calamex"/.test(pkgRaw0)) die('package.json 不是 calamex,请在仓库根目录运行');

const allFiles = walk(srcRoot).filter((f) => /\.(ts|tsx|js|mjs|cjs|vue)$/.test(f));

// needle -> 允许出现的文件白名单(相对路径)
const SCANS = [
  // router.ts 待删;App.spec.ts 本轮整文件重写(移除 vue-router)
  ['vue-router', ['src/app/router.ts', 'src/App.spec.ts']],
  ['useRouter', []],
  ['useRoute', []], // 亦覆盖 useRouter
  // App.vue 历史注释叙述旧 RouterView bug,属被改造目标文件,放行
  ['RouterView', ['src/app/App.vue']],
  ['RouterLink', []],
  // 均为注释叙述(App.vue 僵尸工作台教训 / runtime-diagnostics 错误过滤缘由),非路由消费方
  ['router-view', ['src/app/App.vue', 'src/utils/platform/runtime-diagnostics.ts']],
  ['router-link', []],
  ['$router', []],
  ['$route', []], // 亦覆盖 $router
  ["'./router'", ['src/app/main.ts']],
  ['@/app/router', []],
];

for (const [needle, allow] of SCANS) {
  const allowSet = new Set(allow);
  const hits = [];
  for (const abs of allFiles) {
    const r = rel(abs);
    if (allowSet.has(r)) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes(needle)) hits.push(r);
  }
  if (hits.length) {
    console.error(`\n✗ 发现未预期的「${needle}」引用(白名单外),说明还有未处理的路由消费方:`);
    for (const h of hits) console.error(`  - ${h}`);
    die('需先适配这些文件再移除 vue-router。请把它们贴给我。');
  }
}
console.log('✓ 写前扫描通过:除白名单外无路由残留引用');

// ---- App.spec.ts 新内容(与当前 App.vue 行为一致,不再依赖 vue-router) ----
const APP_SPEC = `import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import App from '@/app/App.vue';
import { runtimeErrorState } from '@/utils/platform/runtime-diagnostics';

// 首帧交接埋点:保留其余真实导出,仅拦截本用例断言的两个函数。
const markStartupMock = vi.hoisted(() => vi.fn());
const reportStartupTimingsMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/platform/startup-profiler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/platform/startup-profiler')>();
  return {
    ...actual,
    markStartup: markStartupMock,
    reportStartupTimings: reportStartupTimingsMock,
  };
});

vi.mock('@/components/common/AppDialogHost.vue', () => ({
  default: {
    name: 'AppDialogHostStub',
    template: '<div data-testid="app-dialog-host-stub"></div>',
  },
}));

vi.mock('@/components/common/BrowserContextMenuHost.vue', () => ({
  default: {
    name: 'BrowserContextMenuHostStub',
    template: '<div data-testid="browser-context-menu-host-stub"></div>',
  },
}));

// 工作台现由 App.vue 直接挂载(不再经 router-view);桩组件用于断言渲染与 ready 事件接线。
vi.mock('@/app/ShellWorkbenchView.vue', () => ({
  default: {
    name: 'ShellWorkbenchViewStub',
    emits: ['ready'],
    template: '<div data-testid="shell-workbench-view"></div>',
  },
}));

const flushUi = async (): Promise<void> => {
  await nextTick();
  await flushPromises();
  await nextTick();
};

describe('App startup handoff', () => {
  beforeEach(() => {
    runtimeErrorState.value = null;
    document.documentElement.dataset.theme = 'dark';
    window.__SH_WINDOW_LABEL__ = 'main';
    markStartupMock.mockClear();
    reportStartupTimingsMock.mockClear();
  });

  afterEach(() => {
    runtimeErrorState.value = null;
    vi.restoreAllMocks();
    delete window.__SH_WINDOW_LABEL__;
  });

  it('直接挂载工作台与全局宿主组件', async () => {
    const wrapper = mount(App);

    await flushUi();

    expect(wrapper.find('[data-testid="app-dialog-host-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="browser-context-menu-host-stub"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="shell-workbench-view"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it('工作台首帧 ready 后上报启动埋点', async () => {
    const wrapper = mount(App);

    wrapper.getComponent({ name: 'ShellWorkbenchViewStub' }).vm.$emit('ready');
    await flushUi();

    expect(markStartupMock).toHaveBeenCalledWith('workbench-ready-event');
    expect(reportStartupTimingsMock).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });
});
`;

// ---- 计算改动(全部先算好,任何 required 失败即在写入前 die) ----
const planned = []; // { rp, content }

// 1) App.vue
{
  const rp = 'src/app/App.vue';
  const raw = readText(rp);
  const eol = detectEol(raw);
  let s = toLf(raw);

  s = replaceIn(
    s,
    "import { defineAsyncComponent } from 'vue';\n",
    "import { defineAsyncComponent } from 'vue';\nimport ShellWorkbenchView from '@/app/ShellWorkbenchView.vue';\n",
    'App.vue: 追加 ShellWorkbenchView import',
  );

  s = replaceIn(
    s,
    '      <router-view v-slot="{ Component: RouteComponent, route: routeRecord }">\n' +
      '        <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="handleWorkbenchReady" />\n' +
      '      </router-view>',
    '      <ShellWorkbenchView @ready="handleWorkbenchReady" />',
    'App.vue: router-view → 直接挂载 ShellWorkbenchView',
  );

  s = replaceIn(
    s,
    '工作台(router-view)始终挂载',
    '工作台(ShellWorkbenchView)始终挂载',
    'App.vue: 注释措辞(router-view→ShellWorkbenchView,仅当前态那行)',
    { optional: true },
  );

  planned.push({ rp, content: s.replace(/\n/g, eol) });
}

// 2) main.ts
{
  const rp = 'src/app/main.ts';
  const raw = readText(rp);
  const eol = detectEol(raw);
  let s = toLf(raw);

  s = replaceIn(
    s,
    "      import('./App.vue'),\n      import('./router'),\n    ]).then((modules) => {",
    "      import('./App.vue'),\n    ]).then((modules) => {",
    "main.ts: Promise.all 移除 import('./router')",
  );

  s = replaceIn(
    s,
    '    const [vueRuntime, { getThemeManager }, { default: App }, { default: router }] =\n      bootstrapModules;',
    '    const [vueRuntime, { getThemeManager }, { default: App }] = bootstrapModules;',
    'main.ts: 解构移除 router',
  );

  s = replaceIn(
    s,
    '    app.use(pinia);\n    app.use(router);\n    app.use(VueQueryPlugin, { queryClient });',
    '    app.use(pinia);\n    app.use(VueQueryPlugin, { queryClient });',
    'main.ts: 移除 app.use(router)',
  );

  s = replaceIn(
    s,
    "    await router.isReady();\n    markStartup('router-ready');\n\n    app.mount('#app');",
    "    app.mount('#app');",
    'main.ts: 移除 await router.isReady()',
  );

  planned.push({ rp, content: s.replace(/\n/g, eol) });
}

// 3) package.json 移除 vue-router 依赖
{
  const rp = 'package.json';
  const raw = readText(rp);
  const eol = detectEol(raw);
  let s = toLf(raw);
  s = replaceIn(s, '    "vue-router": "^5.1.0",\n', '', 'package.json: 移除 vue-router 依赖');
  planned.push({ rp, content: s.replace(/\n/g, eol) });
}

// 4) App.spec.ts 整文件重写(移除 vue-router,匹配当前 App.vue 行为)
{
  const rp = 'src/App.spec.ts';
  const eol = detectEol(readText(rp));
  planned.push({ rp, content: APP_SPEC.replace(/\n/g, eol) });
}

// 5) 待删除文件
const toDelete = ['src/app/router.ts'];
for (const rp of toDelete) if (!fs.existsSync(p(rp))) die(`待删除文件不存在:${rp}`);

// ---- 全部计算通过,统一写入 + 删除 ----
for (const { rp, content } of planned) {
  fs.writeFileSync(p(rp), content, 'utf8');
  console.log(`✓ 写入 ${rp}`);
}
for (const rp of toDelete) {
  fs.rmSync(p(rp));
  console.log(`✓ 删除 ${rp}`);
}

console.log('\n✅ R3 完成:vue-router 已移除,直接挂载 ShellWorkbenchView;App.spec.ts 已对齐当前行为。');
console.log('下一步(必须,同步 lockfile):');
console.log('  pnpm install');
console.log('  pnpm typecheck && pnpm lint && pnpm test\n');