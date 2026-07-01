// setup-vendor.mjs —— 一键 vendored shellcheck/shfmt + 打补丁。放在项目根目录，node setup-vendor.mjs
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync,
  readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const repoRoot = dirname(fileURLToPath(import.meta.url));
const tsFile = join(repoRoot, 'scripts', 'prepare-bundle-resources.ts');
const vendorDir = join(repoRoot, 'src-tauri', 'vendor');

const SHELLCHECK_VERSION = 'v0.11.0';
const SHFMT_VERSION = 'v3.10.0';
// GitHub 加速前缀（挂了就调整顺序 / 增删）；最后一个是直连兜底。
const PREFIXES = ['https://gh-proxy.com/', 'https://ghfast.top/', ''];
const gh = (path) => PREFIXES.map((p) => `${p}https://github.com/${path}`);

const log = (m) => console.log(`[setup-vendor] ${m}`);

async function downloadTo(urls, outPath) {
  for (const url of urls) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        log(`↓ ${url} (第 ${attempt}/3 次)`);
        const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) throw new Error(`文件过小(${buf.length}B)，疑似失败`);
        writeFileSync(outPath, buf);
        log(`  ✓ 已保存 ${outPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
        return true;
      } catch (e) {
        log(`  ✗ 失败：${e?.message ?? e}`);
        await new Promise((r) => setTimeout(r, attempt * 2000));
      }
    }
  }
  return false;
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (entry.name.toLowerCase() === name) {
      return p;
    }
  }
  return null;
}

async function vendorShellcheck() {
  const out = join(vendorDir, 'shellcheck.exe');
  if (existsSync(out)) return log('shellcheck.exe 已存在，跳过下载');
  const zip = join(tmpdir(), 'shellcheck.zip');
  const ok = await downloadTo(
    gh(`koalaman/shellcheck/releases/download/${SHELLCHECK_VERSION}/shellcheck-${SHELLCHECK_VERSION}.zip`),
    zip,
  );
  if (!ok) return log('⚠️  shellcheck 下载失败，请换个网络/代理重跑，或手动放到 src-tauri\\vendor\\shellcheck.exe');
  const extract = join(tmpdir(), 'shellcheck_unzip');
  rmSync(extract, { recursive: true, force: true });
  execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -Path '${zip}' -DestinationPath '${extract}' -Force`,
  ], { stdio: 'inherit' });
  const exe = findFile(extract, 'shellcheck.exe');
  if (!exe) return log('⚠️  解压后没找到 shellcheck.exe');
  copyFileSync(exe, out);
  log(`✓ shellcheck.exe -> ${out}`);
}

async function vendorShfmt() {
  const out = join(vendorDir, 'shfmt.exe');
  if (existsSync(out)) return log('shfmt.exe 已存在，跳过下载');
  const ok = await downloadTo(
    gh(`mvdan/sh/releases/download/${SHFMT_VERSION}/shfmt_${SHFMT_VERSION}_windows_amd64.exe`),
    out,
  );
  if (ok) log(`✓ shfmt.exe -> ${out}`);
  else log('⚠️  shfmt 下载失败（非致命，可稍后再补）');
}

function insertAfter(content, anchor, sentinel, block) {
  if (content.includes(sentinel)) {
    log(`补丁已存在，跳过：${sentinel}`);
    return content;
  }
  const idx = content.indexOf(anchor);
  if (idx === -1) throw new Error(`找不到锚点，无法打补丁：${anchor}`);
  const pos = content.indexOf('\n', idx) + 1;
  log(`✓ 已插入补丁：${sentinel}`);
  return content.slice(0, pos) + block + content.slice(pos);
}

function patchScript() {
  if (!existsSync(tsFile)) throw new Error(`找不到脚本：${tsFile}`);
  let content = readFileSync(tsFile, 'utf8');
  const original = content;

  content = insertAfter(
    content,
    'const dest = join(stageRoot, shellcheckExeName);',
    '[vendor-first:shellcheck]',
    [
      '  // [vendor-first:shellcheck] 仓库自带二进制优先：离线、可复现，不依赖 GitHub / node_modules。',
      '  const vendoredShellcheck = join(srcTauri, \'vendor\', shellcheckExeName);',
      '  if (existsSync(vendoredShellcheck)) {',
      '    copyFileSync(vendoredShellcheck, dest);',
      '    log(`已内置 shellcheck（vendored）：${vendoredShellcheck} -> ${dest}`);',
      '    return;',
      '  }',
      '',
    ].join('\n'),
  );

  content = insertAfter(
    content,
    'const dest = join(stageRoot, shfmtExeName);',
    '[vendor-first:shfmt]',
    [
      '  // [vendor-first:shfmt] 仓库自带二进制优先。',
      '  const vendoredShfmt = join(srcTauri, \'vendor\', shfmtExeName);',
      '  if (existsSync(vendoredShfmt)) {',
      '    copyFileSync(vendoredShfmt, dest);',
      '    log(`已内置 shfmt（vendored）：${vendoredShfmt} -> ${dest}`);',
      '    return;',
      '  }',
      '',
    ].join('\n'),
  );

  if (content !== original) {
    writeFileSync(`${tsFile}.bak`, original);
    writeFileSync(tsFile, content);
    log(`已写入补丁，原文件备份为 ${tsFile}.bak`);
  } else {
    log('脚本无需改动');
  }
}

async function main() {
  mkdirSync(vendorDir, { recursive: true });
  await vendorShellcheck();
  await vendorShfmt();
  patchScript();
  log('完成 ✅  接下来：');
  log('  1) 验证：node --import tsx scripts/prepare-bundle-resources.ts');
  log('  2) 提交：git add src-tauri/vendor scripts/prepare-bundle-resources.ts && git commit -m "chore(vendor): 内置 shellcheck/shfmt 二进制离线打包"');
}

main().catch((e) => {
  console.error(`[setup-vendor] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});