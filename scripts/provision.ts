#!/usr/bin/env node
// scripts/provision.ts
//
// P1 可复现「外部产物准备」。把所有联网/安装从打包期(beforeBundleCommand)
// 挪到这里，产到版本化缓存 .provision/，供 prepare-bundle-resources.ts 纯复制。
//
// 产物布局（与 resources-bundle 一致，便于纯复制）：
//   .provision/node/node.exe
//   .provision/builtin-agent/{package.json,src,dist,node_modules}
//   .provision/lsp/node_modules/bash-language-server/out/cli.js
//   .provision/bin/{shellcheck.exe,shfmt.exe}
//   .provision/manifest.json          （缓存元信息，随 .provision 忽略）
// 校验和锁：provision.lock.json（仓库根，需提交）
//
// 用法：
//   tsx scripts/provision.ts           # 缓存命中即跳过
//   tsx scripts/provision.ts --force   # 强制全部重建
// 环境变量（国内加速，可选）：
//   set NODE_MIRROR=https://cdn.npmmirror.com/binaries/node

import { Buffer } from 'node:buffer';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---- 版本锁（唯一可信来源）----
const NODE_VERSION = '26.2.0';
const NODE_PLATFORM = 'win-x64';
const SHFMT_VERSION = 'v3.10.0';
const BASH_LS_VERSION = '5.6.0';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcTauri = join(repoRoot, 'src-tauri');
const vendorDir = join(srcTauri, 'vendor');
const provisionRoot = join(repoRoot, '.provision');
const lockPath = join(repoRoot, 'provision.lock.json');

const force = process.argv.includes('--force');
const isWindows = process.platform === 'win32';
const nodeExeName = isWindows ? 'node.exe' : 'node';
const shellcheckExeName = isWindows ? 'shellcheck.exe' : 'shellcheck';
const shfmtExeName = isWindows ? 'shfmt.exe' : 'shfmt';

function log(m: string): void {
  console.log('[provision] ' + m);
}
function fail(m: string): never {
  console.error('[provision] FAILED: ' + m);
  process.exit(1);
}
function npmBin(): string {
  return isWindows ? 'npm.cmd' : 'npm';
}
function run(command: string, args: string[], options: { cwd?: string } = {}): void {
  log('$ ' + command + ' ' + args.join(' '));
  const needsShell = isWindows && /\.(cmd|bat)$/i.test(command);
  if (needsShell) {
    const quote = (s: string): string => (/\s/.test(s) ? '"' + s + '"' : s);
    execSync(
      [quote(command)].concat(args.map(quote)).join(' '),
      Object.assign({ stdio: 'inherit' }, options),
    );
    return;
  }
  execFileSync(command, args, Object.assign({ stdio: 'inherit' }, options));
}
function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function loadJson(p: string, fallback: any): any {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(p: string, obj: any): void {
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
function expandZip(zip: string, out: string): void {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Expand-Archive -Path '" + zip + "' -DestinationPath '" + out + "' -Force",
    ],
    { stdio: 'inherit' },
  );
}

// ---- 1) Node（pinned + SHA256）----
async function provisionNode(lock: any): Promise<void> {
  const dest = join(provisionRoot, 'node', nodeExeName);
  if (
    !force &&
    existsSync(dest) &&
    lock.node &&
    lock.node.exeSha256 &&
    sha256File(dest) === lock.node.exeSha256
  ) {
    log('Node 缓存命中，跳过');
    return;
  }
  if (!isWindows) fail('provision 目标为 Windows/NSIS，请在 Windows 上运行');
  const base = process.env.NODE_MIRROR || 'https://nodejs.org/dist';
  const zipName = 'node-v' + NODE_VERSION + '-' + NODE_PLATFORM + '.zip';
  const zipUrl = base + '/v' + NODE_VERSION + '/' + zipName;
  const tmp = join(provisionRoot, '_tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zipPath = join(tmp, zipName);
  log('下载 Node ' + NODE_VERSION + ': ' + zipUrl);
  await download(zipUrl, zipPath);

  let expected = lock.node && lock.node.zipSha256 ? lock.node.zipSha256 : '';
  if (!expected) {
    const res = await fetch(base + '/v' + NODE_VERSION + '/SHASUMS256.txt');
    if (!res.ok) fail('无法获取 SHASUMS256：HTTP ' + res.status);
    const line = (await res.text()).split(/\r?\n/).find((l: string) => l.indexOf(zipName) !== -1);
    if (!line) fail('SHASUMS256 中未找到 ' + zipName);
    expected = line.trim().split(/\s+/)[0];
    log('已从官方 SHASUMS256 记录 Node 校验和');
  }
  const actual = sha256File(zipPath);
  if (actual !== expected) fail('Node 校验失败：期望 ' + expected + ' 实际 ' + actual);

  const outDir = join(tmp, 'unzip');
  mkdirSync(outDir, { recursive: true });
  expandZip(zipPath, outDir);
  const inner = join(outDir, 'node-v' + NODE_VERSION + '-' + NODE_PLATFORM, nodeExeName);
  if (!existsSync(inner)) fail('解压后未找到 node.exe：' + inner);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(inner, dest);
  rmSync(tmp, { recursive: true, force: true });
  lock.node = {
    version: NODE_VERSION,
    platform: NODE_PLATFORM,
    zipSha256: expected,
    exeSha256: sha256File(dest),
  };
  log('已内置 Node（pinned ' + NODE_VERSION + '）: ' + dest);
}

// ---- 2) shellcheck（vendor 唯一可信源 + 校验和）----
function provisionShellcheck(lock: any): void {
  const dest = join(provisionRoot, 'bin', shellcheckExeName);
  mkdirSync(dirname(dest), { recursive: true });
  const vend = join(vendorDir, shellcheckExeName);
  if (!existsSync(vend)) fail('缺少 vendor 二进制：' + vend + '\n请先运行：node setup-vendor.mjs');
  const sha = sha256File(vend);
  if (lock.shellcheck && lock.shellcheck.sha256 && lock.shellcheck.sha256 !== sha) {
    fail('shellcheck 校验和与锁不一致（vendor 被改动？如属预期请删 provision.lock.json 中该项）');
  }
  copyFileSync(vend, dest);
  lock.shellcheck = { source: 'vendor', sha256: sha };
  log('已内置 shellcheck（vendored, sha ' + sha.slice(0, 12) + '…）');
}

// ---- 3) shfmt（vendor 优先；否则官方下载，非致命）----
async function provisionShfmt(lock: any): Promise<void> {
  const dest = join(provisionRoot, 'bin', shfmtExeName);
  mkdirSync(dirname(dest), { recursive: true });
  const vend = join(vendorDir, shfmtExeName);
  if (existsSync(vend)) {
    const sha = sha256File(vend);
    if (lock.shfmt && lock.shfmt.sha256 && lock.shfmt.sha256 !== sha)
      fail('shfmt 校验和与锁不一致');
    copyFileSync(vend, dest);
    lock.shfmt = { source: 'vendor', sha256: sha };
    log('已内置 shfmt（vendored）');
    return;
  }
  const url =
    'https://github.com/mvdan/sh/releases/download/' +
    SHFMT_VERSION +
    '/shfmt_' +
    SHFMT_VERSION +
    '_windows_amd64.exe';
  try {
    await download(url, dest);
    lock.shfmt = { source: 'download', version: SHFMT_VERSION, sha256: sha256File(dest) };
    log('已内置 shfmt（下载 ' + SHFMT_VERSION + '）');
  } catch (e) {
    log('WARN shfmt 缺失且下载失败（非致命，运行时退回系统/WSL）：' + e);
  }
}

// ---- 4) sidecar（builtin-agent：最小运行时依赖 + 单文件 dist）----
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

// ---- 5) bash-language-server ----
function provisionLsp(manifest: any): void {
  const dest = join(provisionRoot, 'lsp');
  const cli = join(dest, 'node_modules', 'bash-language-server', 'out', 'cli.js');
  if (!force && existsSync(cli) && manifest.bashLanguageServer === BASH_LS_VERSION) {
    log('bash-language-server 缓存命中，跳过');
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  run(npmBin(), [
    'install',
    '--no-save',
    '--no-audit',
    '--no-fund',
    '--prefix',
    dest,
    'bash-language-server@' + BASH_LS_VERSION,
  ]);
  if (!existsSync(cli)) fail('bash-language-server 安装后未找到 CLI：' + cli);
  manifest.bashLanguageServer = BASH_LS_VERSION;
  log('已准备 bash-language-server（' + BASH_LS_VERSION + '）');
}

async function main(): Promise<void> {
  if (!isWindows) log('WARN 当前非 Windows；打包目标为 Windows/NSIS。');
  log('provision 根目录：' + provisionRoot + (force ? '（--force）' : ''));
  mkdirSync(provisionRoot, { recursive: true });
  writeFileSync(join(provisionRoot, '.gitignore'), '*\n!.gitignore\n');

  const lock = loadJson(lockPath, {});
  const manifest = loadJson(join(provisionRoot, 'manifest.json'), {});

  await provisionNode(lock);
  provisionShellcheck(lock);
  await provisionShfmt(lock);
  provisionSidecar(manifest);
  provisionLsp(manifest);

  manifest.node = NODE_VERSION;
  manifest.generatedAt = new Date().toISOString();
  writeJson(join(provisionRoot, 'manifest.json'), manifest);
  writeJson(lockPath, lock);
  log('OK provision 完成。请提交 provision.lock.json 固定校验和。');
}

main().catch((e) => fail('未捕获异常：' + (e && e.stack ? e.stack : e)));
