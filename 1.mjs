// 1.mjs — R3: 移除 vue-router(单视图直接挂载 ShellWorkbenchView)
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
  ['vue-router', ['src/app/router.ts']],
  ['useRouter', []],
  ['useRoute', []], // 亦覆盖 useRouter
  ['RouterView', []],
  ['RouterLink', []],
  ['router-view', ['src/app/App.vue']],
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

// ---- 计算改动(全部先算好,任何 required 失败即在写入前 die) ----
const planned = []; // { rp, content }

// 1) App.vue
{
  const rp = 'src/app/App.vue';
  const raw = readText(rp);
  const eol = detectEol(raw);
  let s = toLf(raw);

  // 1a. 补 ShellWorkbenchView import(排在 @/components 之前,符合 biome 顺序)
  s = replaceIn(
    s,
    "import { defineAsyncComponent } from 'vue';\n",
    "import { defineAsyncComponent } from 'vue';\nimport ShellWorkbenchView from '@/app/ShellWorkbenchView.vue';\n",
    'App.vue: 追加 ShellWorkbenchView import',
  );

  // 1b. <router-view> 外壳 → 直接挂载
  s = replaceIn(
    s,
    '      <router-view v-slot="{ Component: RouteComponent, route: routeRecord }">\n' +
      '        <component :is="RouteComponent" :key="routeRecord.fullPath" @ready="handleWorkbenchReady" />\n' +
      '      </router-view>',
    '      <ShellWorkbenchView @ready="handleWorkbenchReady" />',
    'App.vue: router-view → 直接挂载 ShellWorkbenchView',
  );

  // 1c. 修正描述当前态的注释(可选)
  s = replaceIn(
    s,
    '工作台(router-view)始终挂载',
    '工作台(ShellWorkbenchView)始终挂载',
    'App.vue: 注释措辞(router-view→ShellWorkbenchView)',
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

  // 2a. 动态 import 数组移除 ./router
  s = replaceIn(
    s,
    "      import('./App.vue'),\n      import('./router'),\n    ]).then((modules) => {",
    "      import('./App.vue'),\n    ]).then((modules) => {",
    "main.ts: Promise.all 移除 import('./router')",
  );

  // 2b. 解构移除 { default: router }
  s = replaceIn(
    s,
    '    const [vueRuntime, { getThemeManager }, { default: App }, { default: router }] =\n      bootstrapModules;',
    '    const [vueRuntime, { getThemeManager }, { default: App }] = bootstrapModules;',
    'main.ts: 解构移除 router',
  );

  // 2c. 移除 app.use(router)
  s = replaceIn(
    s,
    '    app.use(pinia);\n    app.use(router);\n    app.use(VueQueryPlugin, { queryClient });',
    '    app.use(pinia);\n    app.use(VueQueryPlugin, { queryClient });',
    'main.ts: 移除 app.use(router)',
  );

  // 2d. 移除 await router.isReady() 段(保留 app.mount)
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

// 4) 待删除文件
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

console.log('\n✅ R3 完成:vue-router 已移除,直接挂载 ShellWorkbenchView。');
console.log('下一步(必须,同步 lockfile):');
console.log('  pnpm install');
console.log('  pnpm typecheck && pnpm lint && pnpm test\n');