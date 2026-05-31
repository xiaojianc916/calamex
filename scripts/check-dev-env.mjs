#!/usr/bin/env node
/**
 * 开发环境自检脚本
 * 在 pnpm tauri:dev 启动前执行，快速发现常见环境问题：
 *   1. pnpm 是否可用
 *   2. .cargo/config.toml 是否配置了镜像源
 *   3. cargo 是否可用
 */

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

let hasError = false

function ok(msg) {
  console.log(`  \u2713 ${msg}`)
}

function warn(msg) {
  console.warn(`  \u26a0 ${msg}`)
}

function fail(msg) {
  console.error(`  \u2717 ${msg}`)
  hasError = true
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

// \u5728 PATH \u4e2d\u67e5\u627e cargo\uff1b\u627e\u4e0d\u5230\u518d\u56de\u9000\u5230 rustup \u9ed8\u8ba4\u5b89\u88c5\u4f4d\u7f6e ~/.cargo/bin\u3002
// \u8fd9\u4e0e scripts/run-tauri.mjs \u89e3\u6790 cargo \u7684\u65b9\u5f0f\u4fdd\u6301\u4e00\u81f4\uff1arustup \u5b89\u88c5\u7684 cargo
// \u4f4d\u4e8e %USERPROFILE%\\.cargo\\bin\uff0c\u4f46\u8be5\u76ee\u5f55\u672a\u5fc5\u51fa\u73b0\u5728\u5f53\u524d\u8fdb\u7a0b\u7684 PATH \u4e2d\uff0c
// \u4ec5\u9760 `cargo --version`\uff08\u4f9d\u8d56 PATH\uff09\u4f1a\u8bef\u62a5\u201c\u627e\u4e0d\u5230 cargo\u201d\u3002
function resolveCargoExecutable() {
  const isWindows = process.platform === 'win32'
  const exeName = isWindows ? 'cargo.exe' : 'cargo'

  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, exeName)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home) {
    const fallback = join(home, '.cargo', 'bin', exeName)
    if (existsSync(fallback)) {
      return fallback
    }
  }

  return null
}

console.log('\n[check-dev-env] \u5f00\u59cb\u73af\u5883\u81ea\u68c0...\n')

// 1. pnpm \u53ef\u7528\u6027
const pnpmVer = run('pnpm --version') ?? run('corepack pnpm --version')
if (pnpmVer) {
  ok(`pnpm ${pnpmVer}`)
} else {
  fail('\u627e\u4e0d\u5230 pnpm\uff0c\u8bf7\u8fd0\u884c: corepack enable && corepack prepare pnpm@latest --activate')
}

// 2. .cargo/config.toml \u662f\u5426\u5b58\u5728\u4e14\u914d\u7f6e\u4e86\u955c\u50cf\u6e90
const cargoConfig = join(ROOT, '.cargo', 'config.toml')
if (!existsSync(cargoConfig)) {
  fail(`.cargo/config.toml \u4e0d\u5b58\u5728\uff0cRust \u4f9d\u8d56\u5c06\u4f7f\u7528\u5b98\u65b9\u6e90\uff0c\u5728\u56fd\u5185\u7f51\u7edc\u4e0b\u53ef\u80fd\u5931\u8d25\u3002
    \u4fee\u590d\uff1a\u521b\u5efa .cargo/config.toml \u5e76\u914d\u7f6e rsproxy-sparse \u955c\u50cf\u3002`)
} else {
  const content = readFileSync(cargoConfig, 'utf-8')
  if (content.includes('replace-with') && content.includes('rsproxy')) {
    ok('.cargo/config.toml \u5df2\u914d\u7f6e\u955c\u50cf\u6e90\uff08rsproxy\uff09')
  } else {
    warn('.cargo/config.toml \u5b58\u5728\uff0c\u4f46\u672a\u68c0\u6d4b\u5230 rsproxy \u955c\u50cf\u914d\u7f6e\uff0c\u9047\u5230\u4e0b\u8f7d\u95ee\u9898\u65f6\u8bf7\u68c0\u67e5\u8be5\u6587\u4ef6\u3002')
  }
  if (content.includes('git-fetch-with-cli = true')) {
    ok('git-fetch-with-cli = true\uff08\u53ef\u907f\u514d Windows schannel \u63e1\u624b\u95ee\u9898\uff09')
  } else {
    warn('\u672a\u8bbe\u7f6e git-fetch-with-cli = true\uff0c\u5728 Windows \u4e0b\u53ef\u80fd\u9047\u5230 TLS \u63e1\u624b\u9519\u8bef\u3002')
  }
}

// 3. cargo \u53ef\u7528\u6027
// \u4f18\u5148\u7528\u89e3\u6790\u5230\u7684\u7edd\u5bf9\u8def\u5f84\u6267\u884c\uff0c\u907f\u514d PATH \u4e0d\u542b ~/.cargo/bin \u65f6\u8bef\u62a5\u3002
const cargoExecutable = resolveCargoExecutable()
const cargoVer = cargoExecutable
  ? run(`"${cargoExecutable}" --version`)
  : run('cargo --version')
if (cargoVer) {
  ok(cargoVer)
} else {
  fail('\u627e\u4e0d\u5230 cargo\uff0c\u8bf7\u5b89\u88c5 Rust toolchain: https://rustup.rs')
}

console.log()

if (hasError) {
  console.error('[check-dev-env] \u73af\u5883\u68c0\u67e5\u53d1\u73b0\u9519\u8bef\uff0c\u8bf7\u5148\u4fee\u590d\u540e\u518d\u542f\u52a8\u3002\n')
  process.exit(1)
} else {
  console.log('[check-dev-env] \u73af\u5883\u68c0\u67e5\u901a\u8fc7\u3002\n')
}
