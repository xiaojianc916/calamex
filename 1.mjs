// apply-p3.mjs —— P2 第三轮：provisionSidecar 改为“最小运行时依赖”裁剪
// 仅本地打补丁工具（.mjs）；长期脚本仍是 scripts/provision.ts
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';

const target = 'scripts/provision.ts';
const backup = 'scripts/provision.ts.bak';

if (!existsSync(target)) {
  console.error('[apply-p3] 找不到 ' + target + '，请在仓库根目录运行');
  process.exit(1);
}
const original = readFileSync(target, 'utf8');

const START = '// ---- 4) sidecar';
const END = '// ---- 5) bash-language-server';
const s = original.indexOf(START);
const e = original.indexOf(END);
if (s === -1 || e === -1 || e <= s) {
  console.error('[apply-p3] 未命中 provisionSidecar 区块标记，已中止，未改动文件');
  process.exit(1);
}

const NEWFUNC = String.raw`// ---- 4) sidecar（builtin-agent：最小运行时依赖 + 单文件 dist）----
// P2：dist 已由 esbuild 打成单文件 bundle，进程内依赖全部内联；
// 这里只安装“external 直接依赖 + 其传递依赖”的最小集，大幅缩减 node_modules 体积。
// 注意：playwright / playwright-core / chromium-bidi 是 @mastra/agent-browser 的传递
// 依赖，会被自动带出，无需显式列出。此清单必须与 builtin-agent/build.mjs 的 external 一致。
function provisionSidecar(manifest: any): void {
  const srcDir = join(repoRoot, 'builtin-agent');
  const dest = join(provisionRoot, 'builtin-agent');
  if (!existsSync(srcDir)) fail('未找到 builtin-agent：' + srcDir);

  const RUNTIME_DEPS = [
    '@ast-grep/napi',
    '@libsql/client',
    '@mastra/libsql',
    '@mastra/agent-browser',
    'typescript-language-server',
    '@modelcontextprotocol/server-memory',
    '@modelcontextprotocol/server-sequential-thinking',
    '@upstash/context7-mcp',
    'tavily-mcp',
  ];

  const srcPkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
  const runtimeDeps: Record<string, string> = {};
  for (const name of RUNTIME_DEPS) {
    const ver = srcPkg.dependencies && srcPkg.dependencies[name];
    if (!ver) fail('runtime 依赖缺少版本声明：' + name);
    runtimeDeps[name] = ver;
  }
  const minimalPkg = {
    name: String(srcPkg.name) + '-runtime',
    private: true,
    version: srcPkg.version,
    type: 'module',
    dependencies: runtimeDeps,
  };
  const minimalPkgJson = JSON.stringify(minimalPkg, null, 2);
  const pkgHash = createHash('sha256').update(minimalPkgJson).digest('hex');
  const cached =
    !force && existsSync(join(dest, 'node_modules')) && manifest.builtinAgentPkgHash === pkgHash;

  // 先用源目录（含 dev 依赖：esbuild）产出单文件 dist
  run(npmBin(), ['run', 'build'], { cwd: srcDir });
  const compiled = join(srcDir, 'dist', 'acp', 'stdio-entry.js');
  if (!existsSync(compiled)) fail('sidecar 预编译未找到入口：' + compiled);

  // dest：写最小清单 + 拷 dist（剔除 .map，不再拷 src）
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'package.json'), minimalPkgJson + '\n');
  rmSync(join(dest, 'src'), { recursive: true, force: true });
  rmSync(join(dest, 'dist'), { recursive: true, force: true });
  cpSync(join(srcDir, 'dist'), join(dest, 'dist'), {
    recursive: true,
    filter: (p: string) => !p.endsWith('.map'),
  });

  // 安装最小运行时依赖（external + 传递依赖；仅生产依赖）
  if (cached) {
    log('sidecar 运行时依赖缓存命中，跳过 npm install');
  } else {
    rmSync(join(dest, 'node_modules'), { recursive: true, force: true });
    run(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', dest], {
      cwd: dest,
    });
  }

  manifest.builtinAgentPkgHash = pkgHash;
  log('已准备 builtin-agent（最小运行时依赖 + 单文件 dist）');
}

` + '\n';

if (!existsSync(backup)) {
  copyFileSync(target, backup);
  console.log('[apply-p3] 已备份原始 provision.ts -> provision.ts.bak');
} else {
  console.log('[apply-p3] 备份已存在，保留 provision.ts.bak（不覆盖）');
}

const patched = original.slice(0, s) + NEWFUNC + original.slice(e);
writeFileSync(target, patched);
console.log('[apply-p3] 已改写 provisionSidecar（最小运行时依赖裁剪）');
console.log('[apply-p3] 下一步见对话');